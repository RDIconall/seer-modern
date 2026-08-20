/**
 * Sync waste gates: unchanged message bodies must not be rewritten, and
 * completed folder snapshots must prune prior seen generations.
 */
import assert from "node:assert/strict";
import { startTestDb } from "./v2-testdb.mts";
import { upsertUser, upsertAccount } from "../src/lib/v2/db/accounts.ts";
import {
  beginFolderSnapshot,
  completeFolderSnapshot,
  writeConversationPage,
} from "../src/lib/v2/sync/repository.ts";
import type { Conversation } from "../src/lib/v2/providers/types.ts";

function convo(id: string, body: string, unread = false): Conversation {
  return {
    providerConversationId: id,
    subject: "Waste",
    lastMessageAt: "2026-08-20T12:00:00Z",
    messages: [
      {
        providerMessageId: `${id}-m1`,
        from: { email: "a@example.com", name: "A" },
        to: [{ email: "me@example.com" }],
        cc: [],
        sentAt: "2026-08-20T12:00:00Z",
        snippet: "s",
        bodyHtml: body,
        bodyText: "t",
        isUnread: unread,
        isOutgoing: false,
        attachments: [],
      },
    ],
  };
}

const db = await startTestDb();
try {
  const userId = await upsertUser("waste@example.com");
  const accountId = await upsertAccount({
    userId,
    provider: "google",
    email: "waste@example.com",
  });

  await writeConversationPage(accountId, "inbox", [convo("w1", "<p>one</p>")], []);
  const before = await db.pool.query<{ c: string }>(
    `select ctid::text as c from seer.messages where provider_message_id = 'w1-m1'`,
  );

  // Identical payload — must not rewrite body_html.
  await writeConversationPage(accountId, "inbox", [convo("w1", "<p>one</p>")], []);
  const afterSame = await db.pool.query<{ c: string }>(
    `select ctid::text as c from seer.messages where provider_message_id = 'w1-m1'`,
  );
  assert.equal(
    afterSame.rows[0].c,
    before.rows[0].c,
    "identical message upsert must not update the row",
  );

  // Changed body — must update once.
  await writeConversationPage(accountId, "inbox", [convo("w1", "<p>two</p>")], []);
  const afterChange = await db.pool.query<{ c: string; body_html: string }>(
    `select ctid::text as c, body_html from seer.messages where provider_message_id = 'w1-m1'`,
  );
  assert.notEqual(
    afterChange.rows[0].c,
    before.rows[0].c,
    "changed body must rewrite the row",
  );
  assert.equal(afterChange.rows[0].body_html, "<p>two</p>");

  // Snapshot prune: old generations must not accumulate.
  const gen1 = await beginFolderSnapshot(accountId, "inbox");
  await writeConversationPage(
    accountId,
    "inbox",
    [convo("w1", "<p>two</p>")],
    [],
    gen1.snapshotGeneration,
  );
  await completeFolderSnapshot(
    accountId,
    "inbox",
    gen1.snapshotGeneration!,
    1,
  );

  const gen2 = await beginFolderSnapshot(accountId, "inbox");
  await writeConversationPage(
    accountId,
    "inbox",
    [convo("w1", "<p>two</p>")],
    [],
    gen2.snapshotGeneration,
  );
  await completeFolderSnapshot(
    accountId,
    "inbox",
    gen2.snapshotGeneration!,
    1,
  );

  const seen = await db.pool.query<{ n: number; gens: number }>(
    `select count(*)::int as n,
            count(distinct snapshot_generation)::int as gens
       from seer.folder_sync_seen
      where account_id = $1 and folder = 'inbox'`,
    [accountId],
  );
  assert.equal(seen.rows[0].gens, 1, "only the current snapshot generation remains");
  assert.equal(seen.rows[0].n, 1, "one seen row for the conversation");

  // Outbox conversation_id column exists for indexed mask lookups.
  const col = await db.pool.query<{ column_name: string }>(
    `select column_name from information_schema.columns
      where table_schema = 'seer' and table_name = 'outbox'
        and column_name = 'conversation_id'`,
  );
  assert.equal(col.rowCount, 1, "outbox.conversation_id generated column");

  const pushTable = await db.pool.query<{ relname: string }>(
    `select c.relname from pg_class c
       join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'seer' and c.relname = 'mail_push_subscriptions'`,
  );
  assert.equal(pushTable.rowCount, 1, "mail_push_subscriptions exists");

  console.log("v3-sync-waste: OK");
} finally {
  await db.stop();
}
