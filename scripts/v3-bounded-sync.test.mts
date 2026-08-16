/**
 * Bounded/fair multi-folder sync: huge Sent cannot starve Trash; incremental
 * resume preserves cursors; deadline and page caps stop safely.
 */
import assert from "node:assert/strict";
import { startTestDb } from "./v2-testdb.mts";
import { upsertUser, upsertAccount } from "../src/lib/v2/db/accounts.ts";
import { FakeProvider } from "../src/lib/v2/providers/fake.ts";
import {
  SYNC_PAGE_SAFETY_HEADROOM_MS,
  syncFolder,
} from "../src/lib/v2/sync/engine.ts";
import { syncAccountFolders } from "../src/lib/v2/sync/report.ts";
import type { Message } from "../src/lib/v2/providers/types.ts";

function msg(
  id: string,
  folder: "inbox" | "sent" | "trash",
): Message & { folder: typeof folder } {
  const outgoing = folder === "sent";
  return {
    providerMessageId: id,
    from: {
      email: outgoing ? "me@example.com" : "sender@example.com",
      name: outgoing ? "Me" : "Sender",
    },
    to: [{ email: outgoing ? "client@example.com" : "me@example.com" }],
    cc: [],
    sentAt: "2026-08-01T10:00:00Z",
    snippet: `${folder} snippet`,
    bodyHtml: "<p>b</p>",
    bodyText: "b",
    isUnread: folder === "inbox",
    isOutgoing: outgoing,
    attachments: [],
    folder,
  };
}

function convo(id: string, folder: "inbox" | "sent" | "trash") {
  return {
    providerConversationId: id,
    subject: `${folder} ${id}`,
    messages: [msg(`${id}-m1`, folder)],
  };
}

const db = await startTestDb();
try {
  const userId = await upsertUser("bounded@example.com");
  const accountId = await upsertAccount({
    userId,
    provider: "google",
    email: "bounded@example.com",
  });
  const account = {
    id: accountId,
    userId,
    provider: "google" as const,
    email: "bounded@example.com",
    displayName: null,
  };

  const SENT_COUNT = 120;
  const TRASH_COUNT = 40;
  const provider = new FakeProvider({
    pageSize: 10,
    conversations: [
      ...Array.from({ length: SENT_COUNT }, (_, i) => convo(`sent-${i}`, "sent")),
      ...Array.from({ length: TRASH_COUNT }, (_, i) => convo(`trash-${i}`, "trash")),
      convo("inbox-small-1", "inbox"),
      convo("inbox-small-2", "inbox"),
    ],
  });

  const tick1 = await syncAccountFolders(
    account,
    provider,
    "incremental",
    ["inbox", "sent", "trash"],
    { pagesPerFolder: 2, deadlineMs: Date.now() + 120_000 },
  );

  assert.equal(tick1.length, 3);
  const sent1 = tick1.find((r) => r.folder === "sent")!;
  const trash1 = tick1.find((r) => r.folder === "trash")!;
  const inbox1 = tick1.find((r) => r.folder === "inbox")!;

  assert.equal(sent1.pages, 2, "sent must process exactly 2 pages per tick");
  assert.equal(trash1.pages, 2, "trash must get fair pages despite sent backlog");
  assert.ok(inbox1.pages! >= 1, "inbox participates in fair budget");
  assert.equal(sent1.complete, false, "huge sent must be partial after one tick");
  assert.equal(sent1.backfillComplete, false);
  assert.equal(trash1.complete, false, "trash partial after one tick");
  assert.equal(inbox1.complete, true, "small inbox fully drains within page budget");
  assert.equal(inbox1.backfillComplete, true);
  assert.ok(sent1.nextCursor, "sent must persist partial cursor");

  const sentCursorAfterTick1 = await db.pool.query<{ cursor: string | null }>(
    "select cursor from seer.folder_sync_state where account_id = $1 and folder = 'sent'",
    [accountId],
  );
  assert.equal(sentCursorAfterTick1.rows[0].cursor, sent1.nextCursor);

  const convCountAfterTick1 = await db.pool.query<{ n: number }>(
    "select count(*)::int as n from seer.conversations where account_id = $1",
    [accountId],
  );

  const tick2 = await syncAccountFolders(
    account,
    provider,
    "incremental",
    ["inbox", "sent", "trash"],
    { pagesPerFolder: 2, deadlineMs: Date.now() + 120_000 },
  );
  const sent2 = tick2.find((r) => r.folder === "sent")!;
  assert.equal(
    sent2.nextCursor,
    String(Number(sent1.nextCursor) + 20),
    "incremental tick must resume sent from exact stored cursor",
  );

  const convCountAfterTick2 = await db.pool.query<{ n: number }>(
    "select count(*)::int as n from seer.conversations where account_id = $1",
    [accountId],
  );
  assert.ok(
    convCountAfterTick2.rows[0].n > convCountAfterTick1.rows[0].n,
    "second tick must ingest more rows",
  );
  assert.equal(
    convCountAfterTick2.rows[0].n,
    convCountAfterTick1.rows[0].n + 40,
    "no duplicate rows — only new sent and trash page conversations added",
  );

  const dupes = await db.pool.query<{ provider_conversation_id: string }>(
    `select provider_conversation_id
       from seer.conversations
      where account_id = $1
      group by provider_conversation_id
     having count(*) > 1`,
    [accountId],
  );
  assert.equal(dupes.rowCount, 0, "provider conversation ids must remain unique");

  // Deadline stops before starting another page.
  const deadlineRun = await syncFolder(accountId, provider, "sent", "incremental", {
    maxPages: 100,
    deadlineMs: Date.now() + SYNC_PAGE_SAFETY_HEADROOM_MS - 1,
  });
  assert.equal(deadlineRun.pages, 0, "deadline headroom must stop before first page");
  assert.equal(deadlineRun.complete, false);

  const withinHeadroom = await syncFolder(accountId, provider, "sent", "incremental", {
    maxPages: 5,
    deadlineMs: Date.now() + 5_000,
  });
  assert.equal(
    withinHeadroom.pages,
    0,
    "deadline inside safety headroom must not start a page",
  );
  assert.equal(withinHeadroom.complete, false);

  // Direct syncFolder without options still fully drains a small folder.
  const userId2 = await upsertUser("drain-small@example.com");
  const accountId2 = await upsertAccount({
    userId: userId2,
    provider: "google",
    email: "drain-small@example.com",
  });
  const small = new FakeProvider({
    pageSize: 5,
    conversations: Array.from({ length: 7 }, (_, i) => convo(`inbox-${i}`, "inbox")),
  });
  const drained = await syncFolder(accountId2, small, "inbox", "full");
  assert.equal(drained.pages, 2, "small inbox drains all pages when unbounded");
  assert.equal(drained.complete, true);
  assert.equal(drained.backfillComplete, true);
  assert.equal(drained.nextCursor, null);

  // mode=full resets once per invocation; next incremental does not reset.
  const userId3 = await upsertUser("full-once@example.com");
  const accountId3 = await upsertAccount({
    userId: userId3,
    provider: "google",
    email: "full-once@example.com",
  });
  const bigSent = new FakeProvider({
    pageSize: 10,
    conversations: Array.from({ length: 50 }, (_, i) => convo(`only-sent-${i}`, "sent")),
  });
  const fullPartial = await syncFolder(accountId3, bigSent, "sent", "full", {
    maxPages: 1,
  });
  assert.equal(fullPartial.pages, 1);
  assert.equal(fullPartial.nextCursor, "10");
  assert.equal(fullPartial.backfillComplete, false);
  assert.equal(fullPartial.complete, false);

  const fullResume = await syncFolder(accountId3, bigSent, "sent", "full", {
    maxPages: 1,
  });
  assert.equal(
    fullResume.nextCursor,
    "20",
    "second bounded full must resume cursor while backfill incomplete",
  );

  const incResume = await syncFolder(accountId3, bigSent, "sent", "incremental", {
    maxPages: 1,
  });
  assert.equal(incResume.nextCursor, "30", "incremental must continue backfill from saved cursor");

  const runs = await db.pool.query<{ folder: string; complete: boolean }>(
    `select folder, complete from seer.sync_runs
      where account_id = $1 and folder is not null
      order by started_at desc limit 5`,
    [accountId],
  );
  assert.ok(runs.rowCount! >= 1, "sync_runs must record folder and complete");
  for (const row of runs.rows) {
    assert.ok(["inbox", "sent", "trash"].includes(row.folder));
    assert.equal(typeof row.complete, "boolean");
  }

  console.log("v3-bounded-sync: OK");
} finally {
  await db.stop();
}
