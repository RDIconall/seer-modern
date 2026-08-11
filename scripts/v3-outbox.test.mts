/**
 * Task 4 gate: optimistic corpus patch and outbox enqueue are one transaction;
 * folder transitions, idempotent replay, and undo without provider calls.
 */
import assert from "node:assert/strict";
import { startTestDb } from "./v2-testdb.mts";
import { upsertUser, upsertAccount } from "../src/lib/v2/db/accounts.ts";
import {
  enqueueOptimistic,
  cancelPending,
} from "../src/lib/v3/outbox/repository.ts";
import {
  applyOptimistic,
  revertOptimistic,
} from "../src/lib/v3/outbox/optimistic.ts";
import { inTransaction } from "../src/lib/v2/db/transaction.ts";
import { asAccountId, asConversationId, type AccountId } from "../src/lib/v2/db/types.ts";
import type { OutboxCommand } from "../src/lib/v3/outbox/types.ts";

let seedCounter = 0;

async function seedConversation(
  pool: import("pg").Pool,
  accountId: AccountId,
  folders: string[],
  isUnread: boolean,
): Promise<string> {
  const providerId = `prov-${++seedCounter}`;
  const r = await pool.query<{ id: string }>(
    `insert into seer.conversations
       (account_id, provider_conversation_id, subject, last_message_at, folders, is_unread)
     values ($1, $2, 'subject', now(), $3::text[], $4)
     returning id`,
    [accountId, providerId, folders, isUnread],
  );
  return r.rows[0].id;
}

async function readConversation(
  pool: import("pg").Pool,
  conversationId: string,
): Promise<{ folders: string[]; is_unread: boolean }> {
  const r = await pool.query<{ folders: string[]; is_unread: boolean }>(
    "select folders, is_unread from seer.conversations where id = $1",
    [conversationId],
  );
  return r.rows[0];
}

const db = await startTestDb();
try {
  const userId = await upsertUser("outbox@example.com");
  const accountId = asAccountId(
    await upsertAccount({ userId, provider: "google", email: "outbox@example.com" }),
  );

  // -------------------------------------------------------------------------
  // Optimistic folder transitions
  // -------------------------------------------------------------------------
  const inboxId = await seedConversation(db.pool, accountId, ["inbox"], false);
  const archiveId = await seedConversation(db.pool, accountId, ["inbox", "archive"], false);
  const trashId = await seedConversation(db.pool, accountId, ["trash"], false);
  const unreadId = await seedConversation(db.pool, accountId, ["inbox"], false);

  await inTransaction(async (client) => {
    await applyOptimistic(client, accountId, {
      type: "archive",
      conversationId: inboxId,
      previous: { folders: ["inbox"], isUnread: false },
    });
  });
  assert.deepEqual(
    (await readConversation(db.pool, inboxId)).folders.sort(),
    ["archive"],
    "archive removes inbox and adds archive",
  );

  await inTransaction(async (client) => {
    await applyOptimistic(client, accountId, {
      type: "trash",
      conversationId: archiveId,
      previous: { folders: ["inbox", "archive"], isUnread: false },
    });
  });
  assert.deepEqual(
    (await readConversation(db.pool, archiveId)).folders.sort(),
    ["trash"],
    "trash removes inbox|archive and adds trash",
  );

  await inTransaction(async (client) => {
    await applyOptimistic(client, accountId, {
      type: "restore",
      conversationId: trashId,
      previous: { folders: ["trash"], isUnread: false },
    });
  });
  assert.deepEqual(
    (await readConversation(db.pool, trashId)).folders.sort(),
    ["inbox"],
    "restore removes trash and adds inbox",
  );

  await inTransaction(async (client) => {
    await applyOptimistic(client, accountId, {
      type: "markUnread",
      conversationId: unreadId,
      previous: { folders: ["inbox"], isUnread: false },
    });
  });
  assert.equal(
    (await readConversation(db.pool, unreadId)).is_unread,
    true,
    "markUnread sets is_unread=true",
  );

  // Revert restores exact prior state.
  await inTransaction(async (client) => {
    await revertOptimistic(client, accountId, {
      type: "markUnread",
      conversationId: unreadId,
      previous: { folders: ["inbox"], isUnread: false },
    });
  });
  assert.equal((await readConversation(db.pool, unreadId)).is_unread, false);

  // -------------------------------------------------------------------------
  // Atomicity: patch + enqueue commit or roll back together
  // -------------------------------------------------------------------------
  const atomicId = await seedConversation(db.pool, accountId, ["inbox"], false);
  const atomicCmd: OutboxCommand = {
    type: "archive",
    conversationId: atomicId,
    previous: { folders: ["inbox"], isUnread: false },
  };

  await assert.rejects(
    () =>
      inTransaction(async (client) => {
        await applyOptimistic(client, accountId, atomicCmd);
        await client.query(
          `insert into seer.outbox (account_id, command, idempotency_key, status)
           values ($1, $2::jsonb, $3, 'not-a-status')`,
          [accountId, JSON.stringify(atomicCmd), "atomic-key"],
        );
      }),
    /check constraint|violates check constraint/i,
    "invalid outbox status must roll back the optimistic patch",
  );
  assert.deepEqual(
    (await readConversation(db.pool, atomicId)).folders.sort(),
    ["inbox"],
    "rolled-back transaction must not persist corpus patch",
  );

  const item = await enqueueOptimistic(accountId, atomicCmd, "atomic-key");
  assert.equal(item.status, "pending");
  assert.equal(item.idempotencyKey, "atomic-key");
  assert.deepEqual(
    (await readConversation(db.pool, atomicId)).folders.sort(),
    ["archive"],
    "committed enqueue must persist optimistic patch",
  );

  const outboxCount = await db.pool.query<{ n: number }>(
    "select count(*)::int as n from seer.outbox where account_id = $1 and idempotency_key = $2",
    [accountId, "atomic-key"],
  );
  assert.equal(outboxCount.rows[0].n, 1);

  // -------------------------------------------------------------------------
  // Idempotent replay by key
  // -------------------------------------------------------------------------
  const replay = await enqueueOptimistic(accountId, atomicCmd, "atomic-key");
  assert.equal(replay.id, item.id, "same idempotency key must return existing row");
  assert.equal(replay.status, "pending");

  // -------------------------------------------------------------------------
  // Undo: cancel pending + revert; no provider involvement
  // -------------------------------------------------------------------------
  const undoId = await seedConversation(db.pool, accountId, ["inbox"], true);
  const undoCmd: OutboxCommand = {
    type: "trash",
    conversationId: undoId,
    previous: { folders: ["inbox"], isUnread: true },
  };
  const pending = await enqueueOptimistic(accountId, undoCmd, "undo-key");
  assert.deepEqual(
    (await readConversation(db.pool, undoId)).folders.sort(),
    ["trash"],
    "enqueue applies optimistic trash",
  );

  const cancelled = await cancelPending(accountId, pending.id);
  assert.equal(cancelled, true);
  const row = await db.pool.query<{ status: string }>(
    "select status from seer.outbox where id = $1",
    [pending.id],
  );
  assert.equal(row.rows[0].status, "cancelled");
  assert.deepEqual(
    (await readConversation(db.pool, undoId)).folders.sort(),
    ["inbox"],
    "cancel must revert corpus to exact previous state",
  );
  assert.equal((await readConversation(db.pool, undoId)).is_unread, true);

  const notPending = await cancelPending(accountId, pending.id);
  assert.equal(notPending, false, "cannot cancel a non-pending row");

  console.log("v3-outbox: OK");
} finally {
  await db.stop();
}
