/**
 * Durable outbound idempotency: send/reply/forward reserve a receipt before the
 * provider side effect. Concurrent and crash-boundary retries never duplicate.
 */
import assert from "node:assert/strict";
import { startTestDb } from "./v2-testdb.mts";
import { upsertUser, upsertAccount } from "../src/lib/v2/db/accounts.ts";
import { executeCommand } from "../src/lib/v2/commands/execute.ts";
import {
  completeOutboundReceipt,
  reserveOutboundReceipt,
} from "../src/lib/v2/commands/repository.ts";
import type {
  ForwardCommand,
  MailProvider,
  MutationAction,
  MutationReceipt,
  ProviderKind,
  ReplyCommand,
  SearchResult,
  SendCommand,
  SendReceipt,
  SyncFolder,
  SyncPage,
  AttachmentContent,
} from "../src/lib/v2/providers/types.ts";
import { asConversationId, type AccountId } from "../src/lib/v2/db/types.ts";

/** Provider that never deduplicates — each call is a real send. */
class NonIdempotentProvider implements MailProvider {
  readonly kind: ProviderKind = "google";
  sendCalls = 0;
  replyCalls = 0;

  async sync(): Promise<SyncPage> {
    return { conversations: [], deletedConversationIds: [], nextCursor: null, providerTotal: 0 };
  }
  async syncFolder(_folder: SyncFolder): Promise<SyncPage> {
    return this.sync();
  }
  async getConversation(id: string) {
    return {
      providerConversationId: id,
      subject: "S",
      messages: [],
      lastMessageAt: "",
    };
  }
  async search(): Promise<SearchResult> {
    return { conversations: [], nextCursor: null };
  }
  async send(_command: SendCommand, _key: string): Promise<SendReceipt> {
    void _key;
    this.sendCalls += 1;
    return { providerMessageId: `sent-${this.sendCalls}`, providerConversationId: "sent" };
  }
  async reply(_command: ReplyCommand, _key: string): Promise<SendReceipt> {
    void _key;
    this.replyCalls += 1;
    return { providerMessageId: `reply-${this.replyCalls}`, providerConversationId: "pc-1" };
  }
  async forward(_command: ForwardCommand, _key: string): Promise<SendReceipt> {
    void _key;
    this.sendCalls += 1;
    return { providerMessageId: `fwd-${this.sendCalls}`, providerConversationId: "pc-1" };
  }
  async mutateConversation(
    id: string,
    action: MutationAction,
    _key: string,
  ): Promise<MutationReceipt> {
    void _key;
    return { conversationId: id, action, processed: [], failed: [] };
  }
  async getAttachment(): Promise<AttachmentContent> {
    return { body: Buffer.from("x"), mimeType: "text/plain", filename: "x.txt" };
  }
  nativeUrl(id: string): string {
    return `https://example.com/${id}`;
  }
}

async function seedCorpus(pool: import("pg").Pool, accountId: AccountId, providerId: string) {
  const c = await pool.query<{ id: string }>(
    `insert into seer.conversations
       (account_id, provider_conversation_id, subject, folders, is_unread)
     values ($1, $2, 'S', array['inbox']::text[], false)
     returning id`,
    [accountId, providerId],
  );
  return asConversationId(c.rows[0].id);
}

const db = await startTestDb();
try {
  const userId = await upsertUser("outbound@example.com");
  const accountId = await upsertAccount({
    userId,
    provider: "google",
    email: "outbound@example.com",
  });
  const corpusId = await seedCorpus(db.pool, accountId, "pc-1");
  const provider = new NonIdempotentProvider();
  const ctx = { accountId, provider };

  // Concurrent send with the same key must call the provider only once.
  const [a, b] = await Promise.all([
    executeCommand(ctx, { type: "send", to: ["x@y.com"], subject: "Hi", bodyHtml: "<p>hi</p>" }, "key-concurrent"),
    executeCommand(ctx, { type: "send", to: ["x@y.com"], subject: "Hi", bodyHtml: "<p>hi</p>" }, "key-concurrent"),
  ]);
  assert.equal(provider.sendCalls, 1, "concurrent send must not duplicate provider call");
  assert.ok(a.ok || b.ok, "one concurrent caller must succeed");
  const unknown = [a, b].find((r) => r.unknown);
  const success = [a, b].find((r) => r.ok && !r.replayed);
  assert.ok(unknown || success, "losers must get unknown or success replay");

  // Crash after provider success: pending receipt → retry returns unknown, no resend.
  provider.sendCalls = 0;
  const crashKey = "key-crash";
  assert.equal(await reserveOutboundReceipt(accountId, crashKey, "send"), "reserved");
  const receipt = await provider.send(
    { to: [{ email: "z@y.com" }], subject: "Crash", bodyHtml: "<p>x</p>" },
    crashKey,
  );
  assert.equal(provider.sendCalls, 1);
  // Process dies before completeOutboundReceipt — receipt stays pending.
  const retry = await executeCommand(
    ctx,
    { type: "send", to: ["z@y.com"], subject: "Crash", bodyHtml: "<p>x</p>" },
    crashKey,
  );
  assert.equal(provider.sendCalls, 1, "crash-boundary retry must not resend");
  assert.equal(retry.unknown, true);
  assert.match(retry.error ?? "", /reconcile Sent/);

  // Completing the receipt after the fact allows a clean replay.
  await completeOutboundReceipt(accountId, crashKey, {
    ok: true,
    replayed: false,
    detail: { ...receipt },
  });
  const replay = await executeCommand(
    ctx,
    { type: "send", to: ["z@y.com"], subject: "Crash", bodyHtml: "<p>x</p>" },
    crashKey,
  );
  assert.equal(replay.replayed, true);
  assert.equal(replay.ok, true);
  assert.equal(provider.sendCalls, 1);

  // Reply rejects corpus conversation id.
  const badReply = await executeCommand(
    ctx,
    { type: "reply", providerConversationId: corpusId, all: false, bodyHtml: "<p>nope</p>" },
    "key-bad-reply",
  );
  assert.equal(badReply.ok, false);
  assert.match(badReply.error ?? "", /corpus conversation id/);
  assert.equal(provider.replyCalls, 0);

  // Valid reply uses provider conversation id.
  const reply = await executeCommand(
    ctx,
    { type: "reply", providerConversationId: "pc-1", all: false, bodyHtml: "<p>ok</p>" },
    "key-reply",
  );
  assert.equal(reply.ok, true);
  assert.equal(provider.replyCalls, 1);

  console.log("v3-outbound-idempotency: OK");
} finally {
  await db.stop();
}
