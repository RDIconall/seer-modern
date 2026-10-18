import assert from "node:assert/strict";
import { startTestDb } from "./v2-testdb.mts";
import { upsertAccount, upsertUser } from "../src/lib/v2/db/accounts.ts";
import { asAccountId, type AccountId } from "../src/lib/v2/db/types.ts";
import type { MailAccount } from "../src/lib/v2/db/accounts.ts";
import { executeCommand } from "../src/lib/v2/commands/execute.ts";
import { autotriageAccount } from "../src/lib/v2/autotriage/run.ts";
import { setAutoTriageMode } from "../src/lib/v2/autotriage/repository.ts";

const db = await startTestDb();
const prev = process.env.SEER_AUTOTRIAGE;

async function seedMessage(
  accountId: AccountId,
  providerConv: string,
  providerMsg: string,
  fromEmail: string,
  subject: string,
) {
  const c = await db.pool.query<{ id: string }>(
    `insert into seer.conversations
       (account_id, provider_conversation_id, subject, last_message_at, folders, is_unread)
     values ($1, $2, $3, now(), array['inbox']::text[], false)
     returning id`,
    [accountId, providerConv, subject],
  );
  await db.pool.query(
    `insert into seer.messages
       (account_id, conversation_id, provider_message_id, from_email, sent_at,
        snippet, body_text, is_outgoing)
     values ($1, $2, $3, $4, now(), $5, $5, false)`,
    [accountId, c.rows[0].id, providerMsg, fromEmail, subject],
  );
  return c.rows[0].id;
}

try {
  const userId = await upsertUser("autotriage-undo@example.com");
  const accountId = asAccountId(
    await upsertAccount({
      userId,
      provider: "google",
      email: "autotriage-undo@example.com",
    }),
  );
  const account: MailAccount = {
    id: accountId,
    userId,
    provider: "google",
    email: "autotriage-undo@example.com",
    displayName: null,
    status: "active",
  };
  const ctx = { accountId };

  process.env.SEER_AUTOTRIAGE = "live";
  await setAutoTriageMode(accountId, "live");

  const undoConv = await seedMessage(
    accountId,
    "pc-undo",
    "m-undo",
    "newsletter@labmanager.com",
    "Weekly",
  );
  const first = await autotriageAccount(account, [undoConv]);
  assert.ok(first.logged >= 1);
  const log = await db.pool.query<{ id: string; outbox_id: string }>(
    `select id, outbox_id from seer.autotriage_log
      where account_id = $1 and provider_message_id = 'm-undo'`,
    [accountId],
  );
  assert.ok(log.rows[0].outbox_id);

  const cancelled = await executeCommand(
    ctx,
    { type: "undoAutoTriage", logId: log.rows[0].id },
    "undo-1",
  );
  assert.equal(cancelled.ok, true, cancelled.error);
  const pending = await db.pool.query<{ status: string }>(
    "select status from seer.outbox where id = $1",
    [log.rows[0].outbox_id],
  );
  assert.equal(pending.rows[0].status, "cancelled");
  const folders = await db.pool.query<{ folders: string[] }>(
    "select folders from seer.conversations where provider_conversation_id = 'pc-undo'",
  );
  assert.ok(folders.rows[0].folders.includes("inbox"));

  const restoreConv = await seedMessage(
    accountId,
    "pc-restore",
    "m-restore",
    "newsletter@labmanager.com",
    "Weekly 2",
  );
  await autotriageAccount(account, [restoreConv]);
  const log2 = await db.pool.query<{ id: string; outbox_id: string }>(
    `select id, outbox_id from seer.autotriage_log
      where account_id = $1 and provider_message_id = 'm-restore'`,
    [accountId],
  );
  await db.pool.query("update seer.outbox set status = 'done' where id = $1", [
    log2.rows[0].outbox_id,
  ]);
  const restored = await executeCommand(
    ctx,
    { type: "undoAutoTriage", logId: log2.rows[0].id },
    "undo-2",
  );
  assert.equal(restored.ok, true, restored.error);
  const restoreRow = await db.pool.query<{ command: { type: string } }>(
    `select command from seer.outbox
      where account_id = $1 and idempotency_key = $2`,
    [accountId, `autotriage-undo:${log2.rows[0].id}`],
  );
  assert.equal(restoreRow.rows[0].command.type, "restore");

  const keepConv = await seedMessage(
    accountId,
    "pc-keep",
    "m-keep",
    "blast@substack.com",
    "This week",
  );
  await autotriageAccount(account, [keepConv]);
  const log3 = await db.pool.query<{ id: string }>(
    `select id from seer.autotriage_log
      where account_id = $1 and provider_message_id = 'm-keep'`,
    [accountId],
  );
  const keep = await executeCommand(
    ctx,
    {
      type: "alwaysKeepSender",
      sender: "blast@substack.com",
      logId: log3.rows[0].id,
    },
    "keep-1",
  );
  assert.equal(keep.ok, true, keep.error);

  const keepConv2 = await seedMessage(
    accountId,
    "pc-keep-2",
    "m-keep-2",
    "blast@substack.com",
    "Next week",
  );
  await autotriageAccount(account, [keepConv2]);
  const kept = await db.pool.query<{ action: string }>(
    `select action from seer.autotriage_log
      where account_id = $1 and provider_message_id = 'm-keep-2'`,
    [accountId],
  );
  assert.equal(kept.rows[0].action, "keep");

  console.log("v2-autotriage-undo: OK");
} finally {
  if (prev === undefined) delete process.env.SEER_AUTOTRIAGE;
  else process.env.SEER_AUTOTRIAGE = prev;
  await db.stop();
}
