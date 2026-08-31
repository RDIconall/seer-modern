/**
 * Persist inferred then confirmed mailbox style; leave-in-Inbox hides Focus
 * without touching the provider folder.
 */
import assert from "node:assert/strict";
import { startTestDb } from "./v2-testdb.mts";
import { upsertUser, upsertAccount } from "../src/lib/v2/db/accounts.ts";
import { executeCommand } from "../src/lib/v2/commands/execute.ts";
import {
  confirmMailboxStyle,
  refreshMailboxInference,
} from "../src/lib/v2/intelligence/mailbox-style-store.ts";
import { asConversationId } from "../src/lib/v2/db/types.ts";

const db = await startTestDb();
try {
  const userId = await upsertUser("style@example.com");
  const accountId = await upsertAccount({
    userId,
    provider: "microsoft",
    email: "style@example.com",
  });

  await db.pool.query(
    `insert into seer.folder_sync_state (account_id, folder, provider_total)
     values ($1, 'inbox', 50000)`,
    [accountId],
  );

  const inferred = await refreshMailboxInference(accountId);
  assert.equal(inferred.clearHabit, "leave");
  assert.equal(inferred.confirmed, false);

  const confirmed = await confirmMailboxStyle(accountId, {
    clearHabit: "leave",
    importanceCues: ["unread"],
    matterBar: "high",
  });
  assert.equal(confirmed.confirmed, true);

  const conv = await db.pool.query<{ id: string }>(
    `insert into seer.conversations
       (account_id, provider_conversation_id, subject, folders, is_unread)
     values ($1, 'pc-keep', 'Old thread', array['inbox'], true)
     returning id`,
    [accountId],
  );
  const conversationId = asConversationId(conv.rows[0].id);

  const trained = await executeCommand(
    { accountId },
    {
      type: "trainRelevance",
      conversationId,
      relevant: false,
      reason: "taken_care_of",
    },
    "key-train-1",
  );
  assert.equal(trained.ok, true);
  assert.equal(trained.outboxId, undefined, "leave must not enqueue archive");

  const folders = await db.pool.query<{ folders: string[]; focus_hidden: boolean }>(
    "select folders, focus_hidden from seer.conversations where id = $1",
    [conversationId],
  );
  assert.deepEqual(folders.rows[0].folders, ["inbox"]);
  assert.equal(folders.rows[0].focus_hidden, true);

  const still = await refreshMailboxInference(accountId);
  assert.equal(still.confirmed, true);
  assert.equal(still.clearHabit, "leave", "inference must not overwrite confirm");

  console.log("v2-mailbox-style-store: OK");
} finally {
  await db.stop();
}
