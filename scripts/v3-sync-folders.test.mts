/**
 * Task 3 gate: multi-folder sync persists folder membership, unread state,
 * per-folder cursors, and dedupes by provider conversation id across pages.
 */
import assert from "node:assert/strict";
import { startTestDb } from "./v2-testdb.mts";
import { upsertUser, upsertAccount } from "../src/lib/v2/db/accounts.ts";
import { FakeProvider } from "../src/lib/v2/providers/fake.ts";
import { syncFolder } from "../src/lib/v2/sync/engine.ts";
import { writeConversationPage } from "../src/lib/v2/sync/repository.ts";
import type { Message } from "../src/lib/v2/providers/types.ts";

function msg(
  id: string,
  folder: "inbox" | "sent" | "trash",
  opts: Partial<Message> = {},
): Message & { folder: typeof folder } {
  const outgoing = folder === "sent";
  return {
    providerMessageId: id,
    from: { email: outgoing ? "me@example.com" : "sender@example.com", name: outgoing ? "Me" : "Sender" },
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
    ...opts,
  };
}

const db = await startTestDb();
try {
  const userId = await upsertUser("folders@example.com");
  const accountId = await upsertAccount({
    userId,
    provider: "google",
    email: "folders@example.com",
  });

  const provider = new FakeProvider({
    pageSize: 2,
    conversations: [
      {
        providerConversationId: "inbox-1",
        subject: "Inbox one",
        messages: [msg("inbox-1-m1", "inbox")],
      },
      {
        providerConversationId: "inbox-2",
        subject: "Inbox two",
        messages: [msg("inbox-2-m1", "inbox", { isUnread: false })],
      },
      {
        providerConversationId: "sent-1",
        subject: "Sent one",
        messages: [msg("sent-1-m1", "sent")],
      },
      {
        providerConversationId: "trash-1",
        subject: "Trash one",
        messages: [msg("trash-1-m1", "trash")],
      },
      {
        providerConversationId: "cross-folder",
        subject: "In inbox and sent",
        messages: [
          msg("cross-in", "inbox"),
          msg("cross-out", "sent"),
        ],
      },
    ],
  });

  for (const folder of ["inbox", "sent", "trash"] as const) {
    const run = await syncFolder(accountId, provider, folder, "full");
    assert.ok(run.traceId, `${folder} sync must return a trace id`);
    assert.ok(run.pages >= 1, `${folder} sync must drain at least one page`);
    assert.ok(
      run.coverage.providerTotal >= 0,
      `${folder} providerTotal is reported as an estimate`,
    );
  }

  const rows = await db.pool.query<{
    provider_conversation_id: string;
    folders: string[];
    is_unread: boolean;
  }>(
    `select provider_conversation_id, folders, is_unread
       from seer.conversations
      where account_id = $1
      order by provider_conversation_id`,
    [accountId],
  );

  const byId = Object.fromEntries(rows.rows.map((r) => [r.provider_conversation_id, r]));

  assert.deepEqual(byId["inbox-1"].folders.sort(), ["inbox"]);
  assert.equal(byId["inbox-1"].is_unread, true);
  assert.deepEqual(byId["inbox-2"].folders.sort(), ["inbox"]);
  assert.equal(byId["inbox-2"].is_unread, false);
  assert.deepEqual(byId["sent-1"].folders.sort(), ["sent"]);
  assert.deepEqual(byId["cross-folder"].folders.sort(), ["inbox", "sent"]);

  const sentOutgoing = await db.pool.query<{ is_outgoing: boolean }>(
    `select m.is_outgoing
       from seer.messages m
       join seer.conversations c on c.id = m.conversation_id
      where c.account_id = $1 and c.provider_conversation_id = 'sent-1'`,
    [accountId],
  );
  assert.equal(sentOutgoing.rows.every((r) => r.is_outgoing), true, "sent rows must be outgoing");

  const trashOnly = await db.pool.query<{ n: number }>(
    `select count(*)::int as n
       from seer.conversations
      where account_id = $1
        and folders @> array['inbox']::text[]
        and provider_conversation_id = 'trash-1'`,
    [accountId],
  );
  assert.equal(trashOnly.rows[0].n, 0, "trash rows must not appear in inbox folder membership");

  const cursors = await db.pool.query<{ folder: string; cursor: string | null; provider_total: number }>(
    `select folder, cursor, provider_total
       from seer.folder_sync_state
      where account_id = $1
      order by folder`,
    [accountId],
  );
  assert.equal(cursors.rowCount, 3, "each folder must have folder_sync_state");
  for (const row of cursors.rows) {
    assert.equal(row.cursor, null, `${row.folder} cursor must be null after full drain`);
    assert.ok(row.provider_total >= 0, `${row.folder} provider_total stored`);
  }

  const backfill = await db.pool.query<{ folder: string; backfill_complete: boolean }>(
    `select folder, backfill_complete from seer.folder_sync_state
      where account_id = $1 order by folder`,
    [accountId],
  );
  for (const row of backfill.rows) {
    assert.equal(row.backfill_complete, true, `${row.folder} backfill must be complete after full drain`);
  }

  // Legacy sync_state remains for inbox compatibility.
  const legacy = await db.pool.query<{ cursor: string | null; provider_total: number }>(
    "select cursor, provider_total from seer.sync_state where account_id = $1",
    [accountId],
  );
  assert.equal(legacy.rowCount, 1, "inbox sync must mirror into legacy sync_state");
  assert.equal(legacy.rows[0].cursor, null);

  // Re-syncing the same conversation from another page must not duplicate rows.
  const before = await db.pool.query<{ n: number }>(
    "select count(*)::int as n from seer.conversations where account_id = $1",
    [accountId],
  );
  await syncFolder(accountId, provider, "inbox", "full");
  const after = await db.pool.query<{ n: number }>(
    "select count(*)::int as n from seer.conversations where account_id = $1",
    [accountId],
  );
  assert.equal(after.rows[0].n, before.rows[0].n, "re-sync must dedupe by provider conversation id");

  // Legacy inbox cursor fallback: first incremental run with no folder_sync_state row.
  const userId2 = await upsertUser("legacy-cursor@example.com");
  const accountId2 = await upsertAccount({
    userId: userId2,
    provider: "google",
    email: "legacy-cursor@example.com",
  });
  await db.pool.query(
    `insert into seer.sync_state (account_id, cursor, provider_total)
     values ($1, '2', 5)`,
    [accountId2],
  );
  const legacyProvider = new FakeProvider({
    pageSize: 2,
    conversations: Array.from({ length: 5 }, (_, i) => ({
      providerConversationId: `legacy-${i}`,
      subject: `Legacy ${i}`,
      messages: [msg(`legacy-${i}-m1`, "inbox")],
    })),
  });
  const legacyRun = await syncFolder(accountId2, legacyProvider, "inbox", "incremental");
  assert.equal(
    legacyRun.pages,
    2,
    "incremental inbox must resume from legacy sync_state cursor, not full drain",
  );

  // A Postgres error in one conversation rolls back only that savepoint; the
  // valid row after it still commits in the page transaction.
  const userId3 = await upsertUser("savepoint@example.com");
  const accountId3 = await upsertAccount({
    userId: userId3,
    provider: "google",
    email: "savepoint@example.com",
  });
  const malformed = {
    providerConversationId: "malformed-middle",
    subject: "Malformed",
    messages: [{ ...msg("bad-message", "inbox"), providerMessageId: null as unknown as string }],
    lastMessageAt: "2026-08-01T10:00:00Z",
  };
  const valid = {
    providerConversationId: "valid-after-malformed",
    subject: "Valid",
    messages: [msg("valid-after-message", "inbox")],
    lastMessageAt: "2026-08-01T10:01:00Z",
  };
  const pageResult = await writeConversationPage(
    accountId3,
    "inbox",
    [malformed, valid],
    [],
  );
  assert.equal(pageResult.failed, 1);
  assert.equal(pageResult.stored, 1);
  const afterMalformed = await db.pool.query<{ n: number }>(
    `select count(*)::int as n from seer.conversations
      where account_id = $1 and provider_conversation_id = 'valid-after-malformed'`,
    [accountId3],
  );
  assert.equal(afterMalformed.rows[0].n, 1, "later valid conversation must commit");

  console.log("v3-sync-folders: OK");
} finally {
  await db.stop();
}
