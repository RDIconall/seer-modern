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
    sent_at: string | null;
    body_html: string | null;
    body_text: string | null;
    snippet: string | null;
    is_unread: boolean;
    is_outgoing: boolean;
  }>(
    "select provider_message_id, from_email, from_name, sent_at, body_html, body_text, snippet, is_unread, is_outgoing from seer.messages where conversation_id = $1 order by sent_at",
    [conversationId],
  );
  return {
    providerConversationId: c.rows[0].provider_conversation_id,
    subject: c.rows[0].subject ?? "",
    lastMessageAt: c.rows[0].last_message_at ?? "",
    messages: msgs.rows.map((m) => ({
      providerMessageId: m.provider_message_id,
      from: { email: m.from_email ?? "", name: m.from_name ?? undefined },
      to: [],
      cc: [],
      sentAt: m.sent_at ?? "",
      snippet: m.snippet ?? "",
      bodyHtml: m.body_html,
      bodyText: m.body_text,
      isUnread: m.is_unread,
      isOutgoing: m.is_outgoing,
      attachments: [],
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

  async function worker() {
    for (;;) {
      const index = cursor++;
      if (index >= ids.length || Date.now() > deadline) return;
      const conversationId = ids[index];
      const conversation = await loadConversation(conversationId);
      if (!conversation) continue;
      attempted++;
      const decision = await readConversation({
        accountId,
        conversationId: asConversationId(conversationId),
        conversation,
        context,
        model,
      });
      if (decision.home !== "undecided") decided++;
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(concurrency, ids.length) }, worker),
  );
  return { attempted, decided };
}
