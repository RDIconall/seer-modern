import { db } from "../db/pool";
import {
  asAccountId,
  asConversationId,
  type AccountId,
  type ConversationId,
} from "../db/types";
import { CONTEXT_VERSION, MODEL_VERSION } from "./schema";

/**
 * Which conversations still need a read: those with no current decision, or a
 * successful decision from an older model/context version. A failed read
 * (`undecided`, or a paid model call that never produced a current decision)
 * backs off instead of retrying every five-minute tick — one poison-pill
 * thread used to burn the daily budget and stall the rest of the desk.
 *
 * `$1` is the model version and `$2` the context version in every query built
 * from this fragment; callers number their own parameters from `$3`.
 */
function needsReadQuery(select: string, tail = ""): string {
  return `select ${select}
       from seer.conversations c
       left join seer.conversation_decisions d
         on d.conversation_id = c.id
        and d.account_id = c.account_id
        and d.is_current
       left join lateral (
         select count(*)::int as n, max(u.created_at) as last_at
           from seer.model_usage u
          where u.conversation_id = c.id
            and u.created_at > coalesce(d.decided_at, '-infinity'::timestamptz)
       ) attempts on true
      where c.is_deleted = false
        and c.folders @> array['inbox']::text[]
        and (
          d.id is null
          -- A user correction is law. Model/context rollouts may refresh
          -- successful reads, but must never silently overwrite an explicit
          -- placement, and must never treat a failed read as a stale success.
          or (
            d.home <> 'undecided'
            and d.model_version <> 'user-correction'
            and (d.model_version <> $1 or d.context_version <> $2)
          )
          -- Re-read a thread when new mail arrived after its decision.
          or (
            d.home <> 'undecided'
            and d.model_version <> 'user-correction'
            and c.last_message_at > d.decided_at
          )
          or (
            d.home = 'undecided'
            and d.model_version <> 'user-correction'
            and d.decided_at < now() - interval '24 hours'
          )
        )
        and (
          attempts.last_at is null
          or attempts.last_at < now() - case
            when attempts.n >= 10 then interval '24 hours'
            when attempts.n >= 5 then interval '6 hours'
            when attempts.n >= 2 then interval '1 hour'
            else interval '15 minutes'
          end
        )
        ${tail}`;
}

export async function conversationsNeedingRead(
  accountId: AccountId,
  limit = 200,
): Promise<ConversationId[]> {
  const r = await db().query<{ id: string }>(
    needsReadQuery(
      "c.id",
      `and c.account_id = $3
      order by c.last_message_at desc nulls last
      limit $4`,
    ),
    [MODEL_VERSION, CONTEXT_VERSION, accountId, limit],
  );
  return r.rows.map((row) => asConversationId(row.id));
}

/**
 * The mailboxes with at least one conversation waiting to be read.
 *
 * The read cron used to start a worker invocation for every connected mailbox
 * on every five-minute tick, so a desk with an empty queue still cost a
 * function call to discover it had nothing to do. Asking the queue first means
 * an idle account costs one row in this query instead.
 */
export async function accountIdsNeedingRead(): Promise<AccountId[]> {
  const r = await db().query<{ account_id: string }>(
    needsReadQuery("distinct c.account_id"),
    [MODEL_VERSION, CONTEXT_VERSION],
  );
  return r.rows.map((row) => asAccountId(row.account_id));
}
