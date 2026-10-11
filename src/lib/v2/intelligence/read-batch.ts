import { db } from "../db/pool";
import { asConversationId, type AccountId } from "../db/types";
import { conversationsNeedingRead } from "./queue";
import { loadContextInput } from "./context-loader";
import { loadConversation } from "./load-conversation";
import { readConversation, type ReaderModel } from "./reader";

/**
 * Read a bounded batch of not-yet-read conversations for one account. This is
 * the orchestration the read cron and the shadow runner share: pull the queue,
 * load context once, and run one chief-of-staff read per conversation. There is
 * no snippet path and no classifier — just the single read.
 */

export type ReadBatchResult = {
  attempted: number;
  decided: number;
  /** Model/content failures left unclassified for a later retry. */
  failed: number;
};

export type ReadBatchOptions = {
  limit?: number;
  /** How many conversations to read in parallel. */
  concurrency?: number;
  /** Stop starting new reads once this wall-clock deadline passes. */
  deadlineMs?: number;
};

export async function readBatch(
  accountId: AccountId,
  ownEmail: string,
  model: ReaderModel,
  options: ReadBatchOptions = {},
): Promise<ReadBatchResult> {
  const limit = options.limit ?? 50;
  const concurrency = options.concurrency ?? 6;
  const deadline = options.deadlineMs ?? Number.MAX_SAFE_INTEGER;

  const ids = await conversationsNeedingRead(accountId, limit);
  // Context is loaded once per batch (it changes slowly relative to a batch).
  const context = await loadContextInput(accountId, ownEmail);

  let cursor = 0;
  let decided = 0;
  let attempted = 0;
  let failed = 0;

  async function worker() {
    for (;;) {
      const index = cursor++;
      if (index >= ids.length || Date.now() > deadline) return;
      const conversationId = ids[index];
      const conversation = await loadConversation(conversationId);
      if (!conversation) continue;
      attempted++;
      try {
        await readConversation({
          accountId,
          conversationId: asConversationId(conversationId),
          conversation,
          context,
          model,
        });
        decided++;
      } catch (cause) {
        // No fake Archive and no fourth destination. The queue backs off from
        // a paid attempt; a throw before the model call (incomplete body) is
        // retried on the next tick because it left no model_usage row.
        failed++;
        const message =
          cause instanceof Error ? cause.message.slice(0, 200) : "read failed";
        console.error(`[seer:v2] read failed ${conversationId}:`, message);
        try {
          await db().query(
            `insert into seer.events (account_id, kind, payload)
             values ($1, 'read_failed', $2::jsonb)`,
            [
              accountId,
              JSON.stringify({ conversationId, error: message }),
            ],
          );
        } catch {
          // Telemetry must not hide the classification failure.
        }
      }
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(concurrency, ids.length) }, worker),
  );
  return { attempted, decided, failed };
}
