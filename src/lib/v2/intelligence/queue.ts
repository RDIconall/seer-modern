import { db } from "../db/pool";
import { asConversationId, type AccountId, type ConversationId } from "../db/types";
import { CONTEXT_VERSION, MODEL_VERSION } from "./schema";

/**
 * Which conversations still need a read: those with no current decision, or a
 * successful decision from an older model/context version. A failed read
 * (`undecided`, or a paid model call that never produced a current decision)
 * backs off instead of retrying every five-minute tick — one poison-pill
 * thread used to burn the daily budget and stall the rest of the desk.
 */
export async function conversationsNeedingRead(
  accountId: AccountId,
  limit = 200,
): Promise<ConversationId[]> {
  const r = await db().query<{ id: string }>(
    `select c.id
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
      where c.account_id = $1
        and c.is_deleted = false
        and c.folders @> array['inbox']::text[]
        and (
          d.id is null
          -- A user correction is law. Model/context rollouts may refresh
          -- successful reads, but must never silently overwrite an explicit
          -- placement, and must never treat a failed read as a stale success.
          or (
            d.home <> 'undecided'
            and d.model_version <> 'user-correction'
            and (d.model_version <> $2 or d.context_version <> $3)
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
      order by c.last_message_at desc nulls last
      limit $4`,
    [accountId, MODEL_VERSION, CONTEXT_VERSION, limit],
  );
  return r.rows.map((row) => asConversationId(row.id));
}