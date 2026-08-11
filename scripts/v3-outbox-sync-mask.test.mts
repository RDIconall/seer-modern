/**
 * Outbox sync mask gate: pending archive must block stale inbox sync re-adding inbox.
 */
import assert from "node:assert/strict";
import { startTestDb } from "./v2-testdb.mts";
import { upsertUser, upsertAccount } from "../src/lib/v2/db/accounts.ts";
import { enqueueOptimistic } from "../src/lib/v3/outbox/repository.ts";
import { writeConversationPage } from "../src/lib/v2/sync/repository.ts";
import { asAccountId, type AccountId } from "../src/lib/v2/db/types.ts";
import type { Conversation } from "../src/lib/v2/providers/types.ts";

function convo(providerId: string): Conversation {
  return {
    providerConversationId: providerId,
    subject: "Stale inbox",
    lastMessageAt: "2026-08-01T10:00:00Z",
    messages: [
      {
        providerMessageId: `${providerId}-m1`,
        from: { email: "sender@example.com" },
        to: [{ email: "me@example.com" }],
        cc: [],
        sentAt: "2026-08-01T10:00:00Z",
        snippet: "s",
        bodyHtml: null,
        bodyText: "t",
        isUnread: true,
        isOutgoing: false,
        attachments: [],
      },
    ],
  };
}

const db = await startTestDb();
try {
  const userId = await upsertUser("outbox-sync@example.com");
  const accountId = asAccountId(
    await upsertAccount({
      userId,
      provider: "google",
      email: "outbox-sync@example.com",
    }),
  );

  const inserted = await db.pool.query<{ id: string }>(
    `insert into seer.conversations
       (account_id, provider_conversation_id, subject, folders, is_unread)
     values ($1, 'mask-1', 'Mask', array['inbox']::text[], true)
     returning id`,
    [accountId],
  );
  const conversationId = inserted.rows[0].id;

  await enqueueOptimistic(
    accountId,
    { type: "archive", conversationId },
    "mask-archive",
  );

  const before = await db.pool.query<{ folders: string[] }>(
    "select folders from seer.conversations where id = $1",
    [conversationId],
  );
  assert.deepEqual(before.rows[0].folders.sort(), ["archive"]);

  await writeConversationPage(accountId, "inbox", [convo("mask-1")], []);

  const after = await db.pool.query<{ folders: string[] }>(
    "select folders from seer.conversations where id = $1",
    [conversationId],
  );
  assert.deepEqual(
    after.rows[0].folders.sort(),
    ["archive"],
    "stale inbox sync must not re-add inbox while archive outbox is active",
  );

  console.log("v3-outbox-sync-mask: OK");
} finally {
  await db.stop();
}
