import { db } from "../db/pool";
import type { AccountId } from "../db/types";
import type { ContextInput } from "./context";
import { loadGuidance } from "./operating-model";
import { guidanceFor, loadMailboxStyle } from "./mailbox-style-store";

/**
 * Operating-model and mailbox-style rows are additive. A lagging migration
 * used to reject the whole Promise.all and skip every conversation on the
 * desk; the core people/matters/placements packet is enough to classify.
 */
async function optionalContext<T>(
  label: string,
  load: () => Promise<T>,
  fallback: T,
): Promise<T> {
  try {
    return await load();
  } catch (error) {
    console.error(
      `[seer:v2] ${label} unavailable; reading without it:`,
      error instanceof Error ? error.message : error,
    );
    return fallback;
  }
}

/**
 * Load the business context for an account from the durable store: known
 * people, live matters, and explicit interests. This is what lets a read beat
 * the naive baseline. It is assembled once per read batch and passed to each
 * conversation's context compiler.
 */
export async function loadContextInput(
  accountId: AccountId,
  ownEmail: string,
): Promise<ContextInput> {
  const [people, matters, interests, placements, operatingGuidance, mailboxStyle] = await Promise.all([
    db().query<{ email: string; tier: string; vip: boolean }>(
      "select email, tier, vip from seer.people where account_id = $1",
      [accountId],
    ),
    db().query<{
      id: string;
      title: string;
      counterparty: string | null;
      title_source: string;
      codes: string[] | null;
    }>(
      `select m.id,
              m.title,
              m.org_unit as counterparty,
              m.title_source,
              array_remove(array_agg(distinct mc.code), null) as codes
         from seer.matters m
         left join seer.matter_codes mc on mc.matter_id = m.id
        where m.account_id = $1 and m.status <> 'closed'
        group by m.id`,
      [accountId],
    ),
    db().query<{ topic: string }>(
      "select topic from seer.interest_signals where account_id = $1",
      [accountId],
    ),
    db().query<{
      sender_email: string;
      home: "matter" | "record" | "delete";
      count: number;
    }>(
      `with explicit_placements as (
         select d.account_id,
                d.conversation_id,
                d.home,
                d.decided_at
           from seer.conversation_decisions d
          where d.account_id = $1
            and d.is_current
            and d.model_version = 'user-correction'
            and d.home in ('matter', 'record', 'delete')
            and d.decided_at > now() - interval '180 days'
       ),
       -- Before Triage actions became first-class feedback, moving a model
       -- matter to Archive/Trash was the only correction the UI could express.
       -- Recover those choices from the durable outbox so the user does not
       -- have to make them again for the same sender.
       historical_placements as (
         select o.account_id,
                (o.command->>'conversationId')::uuid as conversation_id,
                case o.command->>'type'
                  when 'archive' then 'record'
                  when 'trash' then 'delete'
                end as home,
                o.updated_at as decided_at
           from seer.outbox o
           join seer.conversation_decisions d
             on d.account_id = o.account_id
            and d.conversation_id::text = o.command->>'conversationId'
            and d.is_current
            and d.home = 'matter'
            and d.model_version <> 'user-correction'
          where o.account_id = $1
            and o.status = 'done'
            and o.command->>'type' in ('archive', 'trash')
            and o.updated_at > now() - interval '180 days'
       ),
       placement as (
         select * from explicit_placements
         union all
         select * from historical_placements
       )
       select lower(sender.from_email) as sender_email,
              p.home,
              count(*)::int as count
         from placement p
         join lateral (
           select m.from_email
             from seer.messages m
            where m.account_id = p.account_id
              and m.conversation_id = p.conversation_id
              and m.is_outgoing = false
              and m.from_email is not null
            order by m.sent_at desc nulls last
            limit 1
         ) sender on true
        group by lower(sender.from_email), p.home`,
      [accountId],
    ),
    optionalContext("operating guidance", () => loadGuidance(accountId), ""),
    optionalContext("mailbox style", () => loadMailboxStyle(accountId), null),
  ]);

  return {
    ownDomain: ownEmail.split("@")[1] ?? "",
    ownEmail,
    people: people.rows.map((p) => ({ email: p.email, tier: p.tier, vip: p.vip })),
    matters: matters.rows.map((m) => ({
      id: m.id,
      title: m.title,
      codes: m.codes ?? [],
      counterparty: m.counterparty ?? "",
      userAuthored: m.title_source === "user",
    })),
    interests: interests.rows.map((i) => i.topic),
    placements: placements.rows.map((item) => ({
      senderEmail: item.sender_email,
      home: item.home,
      count: item.count,
    })),
    operatingGuidance,
    mailboxStyleGuidance: guidanceFor(mailboxStyle),
  };
}
