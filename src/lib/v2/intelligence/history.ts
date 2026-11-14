import { db } from "../db/pool";
import type { AccountId } from "../db/types";
import {
  extractAmount,
  recordCharge,
  type MerchantDb,
} from "./amounts";

/**
 * Behaviour and money baselines derived from the corpus — not a KV blob.
 * Loaded once per read batch.
 */

export type SenderActionStats = {
  archive: number;
  trash: number;
  lastAt: string;
};

export type ActionMemory = Record<string, SenderActionStats>;

const MIN_ACTIONS = 3;
const MIN_CONSISTENCY = 0.75;

export async function loadActionMemory(
  accountId: AccountId,
): Promise<ActionMemory> {
  const rows = await db().query<{
    email: string;
    archive: number;
    trash: number;
    last_at: Date | string | null;
  }>(
    `select lower(sender.from_email) as email,
            count(*) filter (where o.command->>'type' = 'archive')::int as archive,
            count(*) filter (where o.command->>'type' = 'trash')::int as trash,
            max(o.updated_at) as last_at
       from seer.outbox o
       join lateral (
         select m.from_email
           from seer.messages m
          where m.account_id = o.account_id
            and m.conversation_id::text = o.command->>'conversationId'
            and m.is_outgoing = false
            and m.from_email is not null
          order by m.sent_at desc nulls last
          limit 1
       ) sender on true
      where o.account_id = $1
        and o.status = 'done'
        and o.command->>'type' in ('archive', 'trash')
        and o.updated_at > now() - interval '180 days'
      group by lower(sender.from_email)`,
    [accountId],
  );
  const memory: ActionMemory = {};
  for (const row of rows.rows) {
    if (!row.email?.includes("@")) continue;
    memory[row.email] = {
      archive: row.archive,
      trash: row.trash,
      lastAt: row.last_at ? new Date(row.last_at).toISOString() : "",
    };
  }
  return memory;
}

export type LearnedPrior = {
  dominant: "archive" | "trash";
  count: number;
  total: number;
};

export function learnedPrior(
  memory: ActionMemory | null | undefined,
  fromEmail: string,
): LearnedPrior | null {
  const stat = memory?.[fromEmail.toLowerCase().trim()];
  if (!stat) return null;
  const total = stat.archive + stat.trash;
  if (total < MIN_ACTIONS) return null;
  const dominant = stat.trash >= stat.archive ? "trash" : "archive";
  const count = dominant === "trash" ? stat.trash : stat.archive;
  if (count / total < MIN_CONSISTENCY) return null;
  return { dominant, count, total };
}

export async function loadWrittenTo(
  accountId: AccountId,
): Promise<Set<string>> {
  const rows = await db().query<{ email: string }>(
    `select distinct lower(trim(addr)) as email
       from seer.messages m
       cross join lateral unnest(m.to_emails) as addr
      where m.account_id = $1
        and m.is_outgoing = true
        and m.sent_at > now() - interval '18 months'
        and addr like '%@%'`,
    [accountId],
  );
  return new Set(rows.rows.map((row) => row.email).filter(Boolean));
}

export async function loadMerchantDb(accountId: AccountId): Promise<MerchantDb> {
  const rows = await db().query<{
    from_email: string;
    from_name: string | null;
    subject: string | null;
    snippet: string | null;
    body_text: string | null;
    sent_at: Date | string | null;
  }>(
    `select m.from_email, m.from_name, c.subject, m.snippet,
            left(m.body_text, 2000) as body_text, m.sent_at
       from seer.messages m
       join seer.conversations c
         on c.id = m.conversation_id and c.account_id = m.account_id
      where m.account_id = $1
        and m.is_outgoing = false
        and m.from_email is not null
        and m.sent_at > now() - interval '18 months'
        and (
          coalesce(m.snippet, '') ~ '\\$[0-9]'
          or coalesce(c.subject, '') ~ '\\$[0-9]'
          or coalesce(m.body_text, '') ~ '\\$[0-9]'
        )
      order by m.sent_at desc nulls last
      limit 800`,
    [accountId],
  );
  const merchants: MerchantDb = {};
  for (const row of rows.rows) {
    const amount = extractAmount(
      `${row.subject ?? ""}\n${row.snippet ?? ""}\n${row.body_text ?? ""}`,
    );
    if (amount == null) continue;
    recordCharge(
      merchants,
      row.from_email,
      row.from_name ?? "",
      amount,
      row.sent_at ? new Date(row.sent_at).toISOString() : undefined,
    );
  }
  return merchants;
}
