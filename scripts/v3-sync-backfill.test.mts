/**
 * Backfill state machine: completed folders head-poll only; bounded full resumes.
 */
import assert from "node:assert/strict";
import { startTestDb } from "./v2-testdb.mts";
import { upsertUser, upsertAccount } from "../src/lib/v2/db/accounts.ts";
import { FakeProvider } from "../src/lib/v2/providers/fake.ts";
import {
  SYNC_PAGE_SAFETY_HEADROOM_MS,
  syncFolder,
} from "../src/lib/v2/sync/engine.ts";
import { conversationsNeedingRead } from "../src/lib/v2/intelligence/queue.ts";
import type { Message } from "../src/lib/v2/providers/types.ts";

function msg(id: string, folder: "inbox" | "sent"): Message & { folder: typeof folder } {
  return {
    providerMessageId: id,
    from: { email: "s@example.com" },
    to: [{ email: "me@example.com" }],
    cc: [],
    sentAt: "2026-08-01T10:00:00Z",
    snippet: "s",
    bodyHtml: "<p>b</p>",
    bodyText: "b",
    isUnread: true,
    isOutgoing: folder === "sent",
    attachments: [],
    folder,
  };
}

const db = await startTestDb();
try {
  const userId = await upsertUser("backfill@example.com");
  const accountId = await upsertAccount({
    userId,
    provider: "google",
    email: "backfill@example.com",
  });

  const inboxProvider = new FakeProvider({
    pageSize: 5,
    conversations: Array.from({ length: 7 }, (_, i) => ({
      providerConversationId: `inbox-${i}`,
      subject: `In ${i}`,
      messages: [msg(`inbox-${i}-m`, "inbox")],
    })),
  });

  const drained = await syncFolder(accountId, inboxProvider, "inbox", "full");
  assert.equal(drained.pages, 2);
  assert.equal(drained.complete, true);
  assert.equal(drained.backfillComplete, true);
  assert.equal(drained.nextCursor, null);

  const stateAfterDrain = await db.pool.query<{
    cursor: string | null;
    backfill_complete: boolean;
  }>(
    `select cursor, backfill_complete from seer.folder_sync_state
      where account_id = $1 and folder = 'inbox'`,
    [accountId],
  );
  assert.equal(stateAfterDrain.rows[0].cursor, null);
  assert.equal(stateAfterDrain.rows[0].backfill_complete, true);

  const beforeHead = await db.pool.query<{ n: number }>(
    "select count(*)::int as n from seer.conversations where account_id = $1",
    [accountId],
  );

  const headPoll = await syncFolder(accountId, inboxProvider, "inbox", "incremental", {
    maxPages: 5,
  });
  assert.equal(headPoll.pages, 1, "completed folder must head-poll one page only");
  assert.equal(headPoll.polledHead, true);
  assert.equal(headPoll.complete, true);
  assert.equal(headPoll.backfillComplete, true);
  assert.equal(headPoll.nextCursor, null);

  const afterHead = await db.pool.query<{ n: number }>(
    "select count(*)::int as n from seer.conversations where account_id = $1",
    [accountId],
  );
  assert.equal(
    afterHead.rows[0].n,
    beforeHead.rows[0].n,
    "head poll must not re-drain historical pages",
  );

  const userId2 = await upsertUser("full-resume@example.com");
  const accountId2 = await upsertAccount({
    userId: userId2,
    provider: "google",
    email: "full-resume@example.com",
  });
  const sentProvider = new FakeProvider({
    pageSize: 10,
    conversations: Array.from({ length: 50 }, (_, i) => ({
      providerConversationId: `sent-${i}`,
      subject: `S ${i}`,
      messages: [msg(`sent-${i}-m`, "sent")],
    })),
  });

  const full1 = await syncFolder(accountId2, sentProvider, "sent", "full", {
    maxPages: 1,
  });
  assert.equal(full1.pages, 1);
  assert.equal(full1.nextCursor, "10");
  assert.equal(full1.backfillComplete, false);
  assert.equal(full1.complete, false);

  const full2 = await syncFolder(accountId2, sentProvider, "sent", "full", {
    maxPages: 1,
  });
  assert.equal(
    full2.nextCursor,
    "20",
    "repeated bounded full must resume saved cursor, not restart page 1",
  );
  assert.equal(full2.backfillComplete, false);

  const deadlineBeforePage = await syncFolder(
    accountId2,
    sentProvider,
    "sent",
    "full",
    { maxPages: 1, deadlineMs: Date.now() + SYNC_PAGE_SAFETY_HEADROOM_MS - 1 },
  );
  assert.equal(deadlineBeforePage.pages, 0);
  assert.equal(deadlineBeforePage.complete, false);

  const userId3 = await upsertUser("full-deadline@example.com");
  const accountId3 = await upsertAccount({
    userId: userId3,
    provider: "google",
    email: "full-deadline@example.com",
  });
  const completedInbox = new FakeProvider({
    pageSize: 5,
    conversations: Array.from({ length: 3 }, (_, i) => ({
      providerConversationId: `done-inbox-${i}`,
      subject: `Done ${i}`,
      messages: [msg(`done-inbox-${i}-m`, "inbox")],
    })),
  });
  await syncFolder(accountId3, completedInbox, "inbox", "full");

  const abortedFull = await syncFolder(
    accountId3,
    completedInbox,
    "inbox",
    "full",
    { maxPages: 1, deadlineMs: Date.now() + SYNC_PAGE_SAFETY_HEADROOM_MS - 1 },
  );
  assert.equal(abortedFull.pages, 0);
  assert.equal(abortedFull.backfillComplete, true, "deadline before first page must preserve completed state");

  const durableAfterAbort = await db.pool.query<{ backfill_complete: boolean }>(
    `select backfill_complete from seer.folder_sync_state
      where account_id = $1 and folder = 'inbox'`,
    [accountId3],
  );
  assert.equal(durableAfterAbort.rows[0].backfill_complete, true);

  const afterAbortIncremental = await syncFolder(
    accountId3,
    completedInbox,
    "inbox",
    "incremental",
    { maxPages: 5 },
  );
  assert.equal(afterAbortIncremental.polledHead, true, "next incremental must head-poll, not restart backfill");
  assert.equal(afterAbortIncremental.backfillComplete, true);

  // A bounded snapshot carries one generation across ticks. A head poll after
  // an archive on the provider may add/update but must not remove membership.
  const userId4 = await upsertUser("snapshot-reconcile@example.com");
  const accountId4 = await upsertAccount({
    userId: userId4,
    provider: "google",
    email: "snapshot-reconcile@example.com",
  });
  const snapshotConversations = Array.from({ length: 4 }, (_, i) => ({
    providerConversationId: `snapshot-${i}`,
    subject: `Snapshot ${i}`,
    messages: [msg(`snapshot-${i}-m`, "inbox")],
  }));
  const snapshotProvider = new FakeProvider({
    pageSize: 2,
    conversations: snapshotConversations,
  });
  const snapshotFirst = await syncFolder(accountId4, snapshotProvider, "inbox", "full", {
    maxPages: 1,
  });
  assert.equal(snapshotFirst.complete, false);
  const scanStart = await db.pool.query<{
    snapshot_generation: string;
    scan_started_at: Date | null;
  }>(
    `select snapshot_generation, scan_started_at from seer.folder_sync_state
      where account_id = $1 and folder = 'inbox'`,
    [accountId4],
  );
  assert.ok(scanStart.rows[0].scan_started_at, "snapshot start must be durable");
  const snapshotGeneration = scanStart.rows[0].snapshot_generation;

  const snapshotSecond = await syncFolder(accountId4, snapshotProvider, "inbox", "full", {
    maxPages: 1,
  });
  assert.equal(snapshotSecond.complete, true);
  const scanSeen = await db.pool.query<{ n: number }>(
    `select count(*)::int as n from seer.folder_sync_seen
      where account_id = $1 and folder = 'inbox' and snapshot_generation = $2`,
    [accountId4, snapshotGeneration],
  );
  assert.equal(scanSeen.rows[0].n, 4, "each bounded page must mark its provider rows seen");

  (snapshotConversations[0].messages[0] as { folder: string }).folder = "archive";
  const headAfterArchive = await syncFolder(
    accountId4,
    snapshotProvider,
    "inbox",
    "incremental",
    { maxPages: 1 },
  );
  assert.equal(headAfterArchive.polledHead, true);
  const retainedDuringHead = await db.pool.query<{ folders: string[] }>(
    `select folders from seer.conversations
      where account_id = $1 and provider_conversation_id = 'snapshot-0'`,
    [accountId4],
  );
  assert.ok(retainedDuringHead.rows[0].folders.includes("inbox"), "head poll must never remove");

  const rescanFirst = await syncFolder(accountId4, snapshotProvider, "inbox", "full", {
    maxPages: 1,
  });
  assert.equal(rescanFirst.complete, false, "rescan must remain bounded");
  const staleBeforeComplete = await db.pool.query<{ folders: string[] }>(
    `select folders from seer.conversations
      where account_id = $1 and provider_conversation_id = 'snapshot-0'`,
    [accountId4],
  );
  assert.ok(staleBeforeComplete.rows[0].folders.includes("inbox"));
  const rescanSecond = await syncFolder(accountId4, snapshotProvider, "inbox", "full", {
    maxPages: 1,
  });
  assert.equal(rescanSecond.complete, true);
  const staleAfterComplete = await db.pool.query<{ folders: string[] }>(
    `select folders from seer.conversations
      where account_id = $1 and provider_conversation_id = 'snapshot-0'`,
    [accountId4],
  );
  assert.ok(!staleAfterComplete.rows[0].folders.includes("inbox"));

  // A provider-side trash/restore converges both folder memberships, and the
  // removed inbox row cannot remain in the paid read queue.
  (snapshotConversations[1].messages[0] as { folder: string }).folder = "trash";
  await syncFolder(accountId4, snapshotProvider, "trash", "full");
  await syncFolder(accountId4, snapshotProvider, "inbox", "full");
  const trashed = await db.pool.query<{ folders: string[] }>(
    `select folders from seer.conversations
      where account_id = $1 and provider_conversation_id = 'snapshot-1'`,
    [accountId4],
  );
  assert.ok(trashed.rows[0].folders.includes("trash"));
  assert.ok(!trashed.rows[0].folders.includes("inbox"));
  const staleRead = await conversationsNeedingRead(accountId4);
  const trashedId = await db.pool.query<{ id: string }>(
    `select id from seer.conversations
      where account_id = $1 and provider_conversation_id = 'snapshot-1'`,
    [accountId4],
  );
  assert.ok(
    !staleRead.some((id) => String(id) === trashedId.rows[0].id),
    "trash must not enter read queue",
  );
  (snapshotConversations[1].messages[0] as { folder: string }).folder = "inbox";
  await syncFolder(accountId4, snapshotProvider, "inbox", "full");
  await syncFolder(accountId4, snapshotProvider, "trash", "full");
  const restored = await db.pool.query<{ folders: string[] }>(
    `select folders from seer.conversations
      where account_id = $1 and provider_conversation_id = 'snapshot-1'`,
    [accountId4],
  );
  assert.ok(restored.rows[0].folders.includes("inbox"));
  assert.ok(!restored.rows[0].folders.includes("trash"));

  console.log("v3-sync-backfill: OK");
} finally {
  await db.stop();
}
