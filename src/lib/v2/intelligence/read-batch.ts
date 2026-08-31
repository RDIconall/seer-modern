import { db } from "../db/pool";
import { asConversationId, type AccountId } from "../db/types";
import type { Conversation } from "../providers/types";
import { conversationsNeedingRead } from "./queue";
import { loadContextInput } from "./context-loader";
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

async function loadConversation(
  conversationId: string,
): Promise<Conversation | null> {
  const c = await db().query<{
    provider_conversation_id: string;
    subject: string;
    last_message_at: string | null;
  }>(
    "select provider_conversation_id, subject, last_message_at from seer.conversations where id = $1",
    [conversationId],
  );
  if (c.rowCount === 0) return null;
  const msgs = await db().query<{
    provider_message_id: string;
    from_email: string | null;
    from_name: string | null;
    to_emails: string[] | null;
    cc_emails: string[] | null;
    sent_at: string | null;
    body_html: string | null;
    body_text: string | null;
    snippet: string | null;
    is_unread: boolean;
    is_outgoing: boolean;
    attachment_names: string[] | null;
  }>(
    "select provider_message_id, from_email, from_name, to_emails, cc_emails, sent_at, body_html, body_text, snippet, is_unread, is_outgoing, attachment_names from seer.messages where conversation_id = $1 order by sent_at",
    [conversationId],
  );
  return {
    providerConversationId: c.rows[0].provider_conversation_id,
    subject: c.rows[0].subject ?? "",
    lastMessageAt: c.rows[0].last_message_at ?? "",
    messages: msgs.rows.map((m) => ({
      providerMessageId: m.provider_message_id,
      from: { email: m.from_email ?? "", name: m.from_name ?? undefined },
      // Recipients matter: a message addressed directly to the user is a
      // different thing from a broadcast to every vendor, and the read cannot
      // tell them apart without them.
      to: (m.to_emails ?? []).map((email) => ({ email })),
      cc: (m.cc_emails ?? []).map((email) => ({ email })),
      sentAt: m.sent_at ?? "",
      snippet: m.snippet ?? "",
      bodyHtml: m.body_html,
      bodyText: m.body_text,
      isUnread: m.is_unread,
      isOutgoing: m.is_outgoing,
      attachments: (m.attachment_names ?? []).map((filename, i) => ({
        id: `${m.provider_message_id}-${i}`,
        filename,
        mimeType: "",
        sizeBytes: 0,
      })),
    })),
  };
}

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
