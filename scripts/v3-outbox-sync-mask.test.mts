/**
 * Outbox sync mask gate: folder/unread protection across pending, failed
 * reconcile, done convergence window, and newer provider activity.
 */
import assert from "node:assert/strict";
import { startTestDb } from "./v2-testdb.mts";
import { upsertUser, upsertAccount } from "../src/lib/v2/db/accounts.ts";
import { enqueueOptimistic } from "../src/lib/v3/outbox/repository.ts";
import { drainOutbox } from "../src/lib/v3/outbox/drain.ts";
import {
  beginFolderSnapshot,
  completeFolderSnapshot,
  writeConversationPage,
} from "../src/lib/v2/sync/repository.ts";
import { DONE_CONVERGENCE_MS } from "../src/lib/v3/outbox/types.ts";
import { FakeProvider } from "../src/lib/v2/providers/fake.ts";
import { asAccountId, type AccountId } from "../src/lib/v2/db/types.ts";
import type { Conversation } from "../src/lib/v2/providers/types.ts";

function convo(
  providerId: string,
  lastMessageAt: string,
  unread: boolean,
): Conversation {
  return {
    providerConversationId: providerId,
    subject: "Sync",
    lastMessageAt,
    messages: [
      {
        providerMessageId: `${providerId}-m1`,
        from: { email: "sender@example.com" },
        to: [{ email: "me@example.com" }],
        cc: [],
        sentAt: lastMessageAt,
        snippet: "s",
        bodyHtml: null,
        bodyText: "t",
        isUnread: unread,
        isOutgoing: false,
        attachments: [],
      },
    ],
  };
}

const STALE_AT = "2026-08-01T10:00:00Z";

async function account(email: string): Promise<AccountId> {
  const userId = await upsertUser(email);
  return asAccountId(await upsertAccount({ userId, provider: "google", email }));
}

const db = await startTestDb();
try {
  // -------------------------------------------------------------------------
  // Partial drain failure: failed+reconcile_needed blocks immediate stale sync
  // -------------------------------------------------------------------------
  const partialAccount = await account("partial-sync@example.com");
  const partialProvider = new FakeProvider({
    conversations: [
      {
        providerConversationId: "partial-sync",
        subject: "Partial",
        messages: [
          {
            providerMessageId: "m-ok",
            from: { email: "a@example.com" },
            to: [{ email: "me@example.com" }],
            cc: [],
            sentAt: STALE_AT,
            snippet: "s",
            bodyHtml: null,
            bodyText: "t",
            isUnread: false,
            isOutgoing: false,
            attachments: [],
            folder: "inbox",
          },
          {
            providerMessageId: "m-bad",
            from: { email: "a@example.com" },
            to: [{ email: "me@example.com" }],
            cc: [],
            sentAt: STALE_AT,
            snippet: "s",
            bodyHtml: null,
            bodyText: "t",
            isUnread: false,
            isOutgoing: false,
            attachments: [],
            folder: "inbox",
            failMutation: true,
          },
        ],
      },
    ],
  });
  const partial = await db.pool.query<{ id: string }>(
    `insert into seer.conversations
       (account_id, provider_conversation_id, subject, folders, is_unread, last_message_at)
     values ($1, 'partial-sync', 'Partial', array['inbox']::text[], false, $2)
     returning id`,
    [partialAccount, STALE_AT],
  );
  await enqueueOptimistic(
    partialAccount,
    { type: "trash", conversationId: partial.rows[0].id },
    "partial-sync-key",
  );
  await drainOutbox(partialAccount, partialProvider, { limit: 1 });
  const partialOutbox = await db.pool.query<{
    reconcile_needed: boolean;
    status: string;
  }>(
    "select reconcile_needed, status from seer.outbox where idempotency_key = $1",
    ["partial-sync-key"],
  );
  assert.equal(partialOutbox.rows[0].status, "failed");
  assert.equal(partialOutbox.rows[0].reconcile_needed, true);
  await writeConversationPage(
    partialAccount,
    "inbox",
    [convo("partial-sync", STALE_AT, true)],
    [],
  );
  const partialAfter = await db.pool.query<{ folders: string[] }>(
    "select folders from seer.conversations where id = $1",
    [partial.rows[0].id],
  );
  assert.deepEqual(partialAfter.rows[0].folders.sort(), ["trash"]);

  // -------------------------------------------------------------------------
  // Pending archive blocks stale inbox folder merge
  // -------------------------------------------------------------------------
  const pendingAccount = await account("pending-mask@example.com");
  const pending = await db.pool.query<{ id: string }>(
    `insert into seer.conversations
       (account_id, provider_conversation_id, subject, folders, is_unread, last_message_at)
     values ($1, 'mask-pending', 'Mask', array['inbox']::text[], false, $2)
     returning id`,
    [pendingAccount, STALE_AT],
  );
  await enqueueOptimistic(
    pendingAccount,
    { type: "archive", conversationId: pending.rows[0].id },
    "mask-pending",
  );
  await writeConversationPage(
    pendingAccount,
    "inbox",
    [convo("mask-pending", STALE_AT, true)],
    [],
  );
  const pendingAfter = await db.pool.query<{ folders: string[] }>(
    "select folders from seer.conversations where id = $1",
    [pending.rows[0].id],
  );
  assert.deepEqual(pendingAfter.rows[0].folders.sort(), ["archive"]);

  // Pending restore protects its optimistic inbox membership from an
  // authoritative snapshot that has not caught up with the provider yet.
  const restoreAccount = await account("restore-mask@example.com");
  const restore = await db.pool.query<{ id: string }>(
    `insert into seer.conversations
       (account_id, provider_conversation_id, subject, folders, is_unread, last_message_at)
     values ($1, 'mask-restore', 'Restore', array['trash']::text[], false, $2)
     returning id`,
    [restoreAccount, STALE_AT],
  );
  await enqueueOptimistic(
    restoreAccount,
    { type: "restore", conversationId: restore.rows[0].id },
    "mask-restore",
  );
  const restoreSnapshot = await beginFolderSnapshot(restoreAccount, "inbox");
  await completeFolderSnapshot(
    restoreAccount,
    "inbox",
    restoreSnapshot.snapshotGeneration,
    0,
  );
  const restoreMasked = await db.pool.query<{ folders: string[] }>(
    "select folders from seer.conversations where id = $1",
    [restore.rows[0].id],
  );
  assert.ok(
    restoreMasked.rows[0].folders.includes("inbox"),
    "pending restore must preserve optimistic inbox during stale cleanup",
  );
  await db.pool.query(
    `update seer.outbox
        set status = 'done',
            updated_at = now() - ($2::int * interval '1 millisecond')
      where idempotency_key = $1`,
    ["mask-restore", DONE_CONVERGENCE_MS + 60_000],
  );
  const expiredRestoreSnapshot = await beginFolderSnapshot(restoreAccount, "inbox");
  await completeFolderSnapshot(
    restoreAccount,
    "inbox",
    expiredRestoreSnapshot.snapshotGeneration,
    0,
  );
  const restoreExpired = await db.pool.query<{ folders: string[] }>(
    "select folders from seer.conversations where id = $1",
    [restore.rows[0].id],
  );
  assert.ok(
    !restoreExpired.rows[0].folders.includes("inbox"),
    "expired restore mask may reconcile stale inbox membership",
  );

  // -------------------------------------------------------------------------
  // markUnread pending protects is_unread from stale provider read state
  // -------------------------------------------------------------------------
  const unreadAccount = await account("unread-mask@example.com");
  const unread = await db.pool.query<{ id: string }>(
    `insert into seer.conversations
       (account_id, provider_conversation_id, subject, folders, is_unread, last_message_at)
     values ($1, 'mask-unread', 'Unread', array['inbox']::text[], false, $2)
     returning id`,
    [unreadAccount, STALE_AT],
  );
  await enqueueOptimistic(
    unreadAccount,
    { type: "markUnread", conversationId: unread.rows[0].id },
    "mask-unread",
  );
  await writeConversationPage(
    unreadAccount,
    "inbox",
    [convo("mask-unread", STALE_AT, false)],
    [],
  );
  const unreadAfter = await db.pool.query<{ is_unread: boolean }>(
    "select is_unread from seer.conversations where id = $1",
    [unread.rows[0].id],
  );
  assert.equal(unreadAfter.rows[0].is_unread, true);

  // -------------------------------------------------------------------------
  // Done within convergence window: stale provider activity still masked
  // -------------------------------------------------------------------------
  const doneAccount = await account("done-mask@example.com");
  const doneProvider = new FakeProvider({
    conversations: [
      {
        providerConversationId: "done-mask",
        subject: "Done",
        messages: [
          {
            providerMessageId: "m-done",
            from: { email: "a@example.com" },
            to: [{ email: "me@example.com" }],
            cc: [],
            sentAt: STALE_AT,
            snippet: "s",
            bodyHtml: null,
            bodyText: "t",
            isUnread: false,
            isOutgoing: false,
            attachments: [],
            folder: "inbox",
          },
        ],
      },
      {
        providerConversationId: "expired-mask",
        subject: "Expired",
        messages: [
          {
            providerMessageId: "m-expired",
            from: { email: "a@example.com" },
            to: [{ email: "me@example.com" }],
            cc: [],
            sentAt: STALE_AT,
            snippet: "s",
            bodyHtml: null,
            bodyText: "t",
            isUnread: false,
            isOutgoing: false,
            attachments: [],
            folder: "inbox",
          },
        ],
      },
    ],
  });
  const done = await db.pool.query<{ id: string }>(
    `insert into seer.conversations
       (account_id, provider_conversation_id, subject, folders, is_unread, last_message_at)
     values ($1, 'done-mask', 'Done', array['inbox']::text[], false, $2)
     returning id`,
    [doneAccount, STALE_AT],
  );
  await enqueueOptimistic(
    doneAccount,
    { type: "archive", conversationId: done.rows[0].id },
    "done-mask-key",
  );
  await drainOutbox(doneAccount, doneProvider, { limit: 1 });

  const recentDone = new Date(Date.now() - 60_000).toISOString();
  await db.pool.query(
    "update seer.outbox set updated_at = $2 where idempotency_key = $1",
    ["done-mask-key", recentDone],
  );
  const staleIncoming = new Date(Date.parse(recentDone) - 60_000).toISOString();
  await writeConversationPage(
    doneAccount,
    "inbox",
    [convo("done-mask", staleIncoming, true)],
    [],
  );
  const doneStale = await db.pool.query<{ folders: string[] }>(
    "select folders from seer.conversations where id = $1",
    [done.rows[0].id],
  );
  assert.deepEqual(doneStale.rows[0].folders.sort(), ["archive"]);

  // Done + newer provider reply: inbox must be re-added
  const newerIncoming = new Date(Date.parse(recentDone) + 60_000).toISOString();
  await writeConversationPage(
    doneAccount,
    "inbox",
    [convo("done-mask", newerIncoming, true)],
    [],
  );
  const doneNewer = await db.pool.query<{ folders: string[]; is_unread: boolean }>(
    "select folders, is_unread from seer.conversations where id = $1",
    [done.rows[0].id],
  );
  assert.ok(doneNewer.rows[0].folders.includes("inbox"));
  assert.equal(doneNewer.rows[0].is_unread, true);

  // Done outside convergence window: mask expires
  const expired = await db.pool.query<{ id: string }>(
    `insert into seer.conversations
       (account_id, provider_conversation_id, subject, folders, is_unread, last_message_at)
     values ($1, 'expired-mask', 'Expired', array['inbox']::text[], false, $2)
     returning id`,
    [doneAccount, STALE_AT],
  );
  await enqueueOptimistic(
    doneAccount,
    { type: "archive", conversationId: expired.rows[0].id },
    "expired-mask-key",
  );
  await drainOutbox(doneAccount, doneProvider, { limit: 1 });
  await db.pool.query(
    `update seer.outbox
        set updated_at = now() - ($2::int * interval '1 millisecond')
      where idempotency_key = $1`,
    ["expired-mask-key", DONE_CONVERGENCE_MS + 60_000],
  );
  await writeConversationPage(
    doneAccount,
    "inbox",
    [convo("expired-mask", STALE_AT, true)],
    [],
  );
  const expiredAfter = await db.pool.query<{ folders: string[] }>(
    "select folders from seer.conversations where id = $1",
    [expired.rows[0].id],
  );
  assert.ok(expiredAfter.rows[0].folders.includes("inbox"));

  // A provider tombstone must also respect the optimistic folder mask. A
  // pending restore wins over a stale provider-side archive/tombstone.
  const tombstoneAccount = await account("restore-tombstone-mask@example.com");
  const tombstone = await db.pool.query<{ id: string }>(
    `insert into seer.conversations
       (account_id, provider_conversation_id, subject, folders, is_unread, last_message_at)
     values ($1, 'mask-tombstone', 'Tombstone', array['trash']::text[], false, $2)
     returning id`,
    [tombstoneAccount, STALE_AT],
  );
  await enqueueOptimistic(
    tombstoneAccount,
    { type: "restore", conversationId: tombstone.rows[0].id },
    "mask-tombstone",
  );
  await writeConversationPage(
    tombstoneAccount,
    "inbox",
    [],
    ["mask-tombstone"],
  );
  const tombstoneAfter = await db.pool.query<{ folders: string[] }>(
    "select folders from seer.conversations where id = $1",
    [tombstone.rows[0].id],
  );
  assert.ok(
    tombstoneAfter.rows[0].folders.includes("inbox"),
    "pending restore must preserve inbox against a provider tombstone",
  );

  console.log("v3-outbox-sync-mask: OK");
} finally {
  await db.stop();
}
