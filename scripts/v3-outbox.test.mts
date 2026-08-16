/**
 * Task 4 gate: optimistic corpus patch and outbox enqueue are one transaction;
 * folder transitions, concurrent idempotent replay, conditional revert, undo.
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
  computeExpected,
  revertOptimistic,
  lockConversation,
} from "../src/lib/v3/outbox/optimistic.ts";
import { inTransaction } from "../src/lib/v2/db/transaction.ts";
import { asAccountId, type AccountId } from "../src/lib/v2/db/types.ts";
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
  // Optimistic folder transitions (internal snapshots)
  // -------------------------------------------------------------------------
  const inboxId = await seedConversation(db.pool, accountId, ["inbox"], false);
  const archiveId = await seedConversation(db.pool, accountId, ["inbox", "archive"], false);
  const trashId = await seedConversation(db.pool, accountId, ["trash"], false);
  const unreadId = await seedConversation(db.pool, accountId, ["inbox"], false);

  async function applyType(
    conversationId: string,
    type: OutboxCommand["type"],
    beforeFolders: string[],
    beforeUnread: boolean,
  ) {
    const previous = { folders: beforeFolders, isUnread: beforeUnread };
    const command: OutboxCommand = {
      type,
      conversationId,
      previous,
      expected: computeExpected(type, previous),
    };
    await inTransaction(async (client) => {
      await applyOptimistic(client, accountId, command);
    });
  }

  await applyType(inboxId, "archive", ["inbox"], false);
  assert.deepEqual((await readConversation(db.pool, inboxId)).folders.sort(), ["archive"]);

  await applyType(archiveId, "trash", ["inbox", "archive"], false);
  assert.deepEqual((await readConversation(db.pool, archiveId)).folders.sort(), ["trash"]);

  await applyType(trashId, "restore", ["trash"], false);
  assert.deepEqual((await readConversation(db.pool, trashId)).folders.sort(), ["inbox"]);

  await applyType(unreadId, "markUnread", ["inbox"], false);
  assert.equal((await readConversation(db.pool, unreadId)).is_unread, true);

  await inTransaction(async (client) => {
    const outcome = await revertOptimistic(client, accountId, {
      type: "markUnread",
      conversationId: unreadId,
      previous: { folders: ["inbox"], isUnread: false },
      expected: { folders: ["inbox"], isUnread: true },
    });
    assert.equal(outcome, "reverted");
  });
  assert.equal((await readConversation(db.pool, unreadId)).is_unread, false);

  // -------------------------------------------------------------------------
  // Atomicity: patch + enqueue commit or roll back together
  // -------------------------------------------------------------------------
  const atomicId = await seedConversation(db.pool, accountId, ["inbox"], false);

  await assert.rejects(
    () =>
      inTransaction(async (client) => {
        const locked = await lockConversation(client, accountId, atomicId);
        const previous = { folders: locked!.folders, isUnread: locked!.isUnread };
        const command: OutboxCommand = {
          type: "archive",
          conversationId: atomicId,
          previous,
          expected: computeExpected("archive", previous),
        };
        await applyOptimistic(client, accountId, command);
        await client.query(
          `insert into seer.outbox (account_id, command, idempotency_key, status)
           values ($1, $2::jsonb, $3, 'not-a-status')`,
          [accountId, JSON.stringify(command), "atomic-key"],
        );
      }),
    /check constraint|violates check constraint/i,
  );
  assert.deepEqual(
    (await readConversation(db.pool, atomicId)).folders.sort(),
    ["inbox"],
    "rolled-back transaction must not persist corpus patch",
  );

  const item = await enqueueOptimistic(
    accountId,
    { type: "archive", conversationId: atomicId },
    "atomic-key",
  );
  assert.equal(item.status, "pending");
  assert.deepEqual(item.command.previous.folders.sort(), ["inbox"]);
  assert.deepEqual(item.command.expected.folders.sort(), ["archive"]);
  assert.deepEqual((await readConversation(db.pool, atomicId)).folders.sort(), ["archive"]);

  // -------------------------------------------------------------------------
  // Idempotent replay + concurrent enqueue
  // -------------------------------------------------------------------------
  const replay = await enqueueOptimistic(
    accountId,
    { type: "archive", conversationId: atomicId },
    "atomic-key",
  );
  assert.equal(replay.id, item.id);

  const concurrentId = await seedConversation(db.pool, accountId, ["inbox"], false);
  const results = await Promise.all(
    Array.from({ length: 8 }, () =>
      enqueueOptimistic(
        accountId,
        { type: "trash", conversationId: concurrentId },
        "concurrent-key",
      ),
    ),
  );
  const uniqueIds = new Set(results.map((r) => r.id));
  assert.equal(uniqueIds.size, 1, "concurrent duplicate keys must return one row");
  assert.deepEqual(
    (await readConversation(db.pool, concurrentId)).folders.sort(),
    ["trash"],
    "optimistic patch applied exactly once",
  );
  const concurrentRows = await db.pool.query<{ n: number }>(
    "select count(*)::int as n from seer.outbox where idempotency_key = $1",
    ["concurrent-key"],
  );
  assert.equal(concurrentRows.rows[0].n, 1);

  // -------------------------------------------------------------------------
  // Undo: cancel pending + conditional revert
  // -------------------------------------------------------------------------
  const undoId = await seedConversation(db.pool, accountId, ["inbox"], true);
  const pending = await enqueueOptimistic(
    accountId,
    { type: "trash", conversationId: undoId },
    "undo-key",
  );
  const cancelled = await cancelPending(accountId, pending.id);
  assert.equal(cancelled, true);
  assert.deepEqual((await readConversation(db.pool, undoId)).folders.sort(), ["inbox"]);

  // Rollback clobber: later command must not be overwritten by cancel of earlier.
  const clobberId = await seedConversation(db.pool, accountId, ["inbox"], false);
  const first = await enqueueOptimistic(
    accountId,
    { type: "archive", conversationId: clobberId },
    "clobber-1",
  );
  const second = await enqueueOptimistic(
    accountId,
    { type: "trash", conversationId: clobberId },
    "clobber-2",
  );
  assert.deepEqual((await readConversation(db.pool, clobberId)).folders.sort(), ["trash"]);
  await cancelPending(accountId, first.id);
  assert.deepEqual(
    (await readConversation(db.pool, clobberId)).folders.sort(),
    ["trash"],
    "cancel of superseded command must not clobber later optimistic state",
  );
  const reconcile = await db.pool.query<{ kind: string }>(
    "select kind from seer.events where account_id = $1 and idempotency_key = $2",
    [accountId, first.idempotencyKey],
  );
  assert.ok(
    reconcile.rows.some((e) => e.kind === "outbox_reconcile_needed"),
    "conflict revert must raise reconcile event",
  );
  assert.equal(second.status, "pending");

  console.log("v3-outbox: OK");
} finally {
  await db.stop();
}
