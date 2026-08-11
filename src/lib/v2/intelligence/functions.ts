import { db } from "../db/pool";
import type { AccountId } from "../db/types";

/**
 * The sections of the user's whiteboard — their own org chart, not a taxonomy
 * the model invented. A matter may only be filed under a name that exists here,
 * which is what keeps the board stable: the model chooses a shelf, it never
 * builds new ones.
 */

/** The starting registry, matching how the previous system filed matters. */
export const DEFAULT_FUNCTIONS = [
  "board",
  "sales — leads",
  "sales — new requests",
  "sales — contracting",
  "marketing",
  "operations — studies",
  "quality",
  "systems (it)",
  "recruiting",
  "hr",
  "finance (ar/ap)",
  "office / facilities",
  "personal",
];

/** Where a matter goes when nothing fits — never invent a section for it. */
export const UNFILED = "unfiled";

export async function listFunctions(accountId: AccountId): Promise<string[]> {
  const result = await db().query<{ name: string }>(
    "select name from seer.functions where account_id = $1 order by position, name",
    [accountId],
  );
  return result.rows.map((r) => r.name);
}

/** Seed the registry once. Existing names keep their position. */
export async function seedFunctions(
  accountId: AccountId,
  names: string[] = DEFAULT_FUNCTIONS,
): Promise<number> {
  if (names.length === 0) return 0;
  const result = await db().query(
    `insert into seer.functions (account_id, name, position)
     select $1, name, ordinality - 1
       from unnest($2::text[]) with ordinality as t(name, ordinality)
     on conflict (account_id, name) do nothing`,
    [accountId, names],
  );
  return result.rowCount ?? 0;
}

/**
 * File a matter under a function. A filing the user made themselves is a
 * decision, so an automatic pass will not move it.
 */
export async function fileMatter(
  matterId: string,
  functionName: string,
  source: "inferred" | "user",
): Promise<boolean> {
  const result = await db().query(
    `update seer.matters
        set function_name = $2, function_source = $3, updated_at = now()
      where id = $1
        and ($3 = 'user' or coalesce(function_source, 'inferred') <> 'user')`,
    [matterId, functionName, source],
  );
  return (result.rowCount ?? 0) > 0;
}

/**
 * File a conversation under a function. Triage groups by this, so a
 * conversation that never became a matter still lands in the right part of the
 * business. A user's own filing is preserved, exactly as for matters.
 */
export async function fileConversation(
  conversationId: string,
  functionName: string,
  source: "inferred" | "user",
): Promise<boolean> {
  const result = await db().query(
    `update seer.conversations
        set function_name = $2, function_source = $3
      where id = $1
        and ($3 = 'user' or coalesce(function_source, 'inferred') <> 'user')`,
    [conversationId, functionName, source],
  );
  return (result.rowCount ?? 0) > 0;
}

/**
 * Conversations that need a section: they have been read, are not part of a
 * matter (those inherit the matter's section on the board), and are not filed.
 * Newest first, because that is what the user is looking at.
 */
export async function conversationsNeedingFiling(
  accountId: AccountId,
  limit: number,
): Promise<{ id: string; subject: string; from: string; summary: string }[]> {
  const result = await db().query<{
    id: string;
    subject: string | null;
    from_email: string | null;
    summary: string | null;
  }>(
    `select c.id, c.subject, d.summary,
            (select m.from_email from seer.messages m
              where m.conversation_id = c.id
              order by m.sent_at desc nulls last limit 1) as from_email
       from seer.conversations c
       join seer.conversation_decisions d
         on d.conversation_id = c.id and d.is_current
      where c.account_id = $1
        and c.is_deleted = false
        and c.function_name is null
        and d.home <> 'matter'
      order by c.last_message_at desc nulls last
      limit $2`,
    [accountId, limit],
  );
  return result.rows.map((r) => ({
    id: r.id,
    subject: r.subject ?? "",
    from: r.from_email ?? "",
    summary: r.summary ?? "",
  }));
}

/** Matters still needing a section, newest first. */
export async function mattersNeedingFiling(
  accountId: AccountId,
  limit: number,
): Promise<{ id: string; title: string; orgUnit: string | null }[]> {
  const result = await db().query<{
    id: string;
    title: string;
    org_unit: string | null;
  }>(
    `select id, title, org_unit
       from seer.matters
      where account_id = $1 and function_name is null
      order by updated_at desc
      limit $2`,
    [accountId, limit],
  );
  return result.rows.map((r) => ({
    id: r.id,
    title: r.title,
    orgUnit: r.org_unit,
  }));
}
