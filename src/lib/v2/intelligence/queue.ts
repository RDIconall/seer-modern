import { db } from "../db/pool";
import { asConversationId, type AccountId, type ConversationId } from "../db/types";
import { CONTEXT_VERSION, MODEL_VERSION } from "./schema";

/**
 * Which conversations still need a read: those with no current decision, or a
 * decision from an older model/context version. Undecided reads retry at most
 * once per day — enough to recover from a model outage or a strong-tier daily
 * cap without hammering the same expensive case every five-minute cron tick.
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
      where c.account_id = $1
        and c.is_deleted = false
        and c.folders @> array['inbox']::text[]
        and (
          d.id is null
          -- A user correction is law. Model/context rollouts may refresh model
          -- reads, but must never silently overwrite an explicit placement.
          or (
            d.model_version <> 'user-correction'
            and (d.model_version <> $2 or d.context_version <> $3)
          )
          -- Re-read a thread when new mail arrived after its decision. This was
          -- previously missing, so a current-version decision could survive
          -- forever while the conversation changed underneath it.
          or (
            d.model_version <> 'user-correction'
            and c.last_message_at > d.decided_at
          )
          or (
            d.home = 'undecided'
            and d.model_version <> 'user-correction'
            and d.decided_at < now() - interval '24 hours'
          )
        )
      order by c.last_message_at desc nulls last
      limit $4`,
    [accountId, MODEL_VERSION, CONTEXT_VERSION, limit],
  );
  return r.rows.map((row) => asConversationId(row.id));
}
