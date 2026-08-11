import type { PoolClient } from "pg";
import { inTransaction } from "@/lib/v2/db/transaction";
import { db } from "@/lib/v2/db/pool";
import type { AccountId } from "@/lib/v2/db/types";
import { applyOptimistic, revertOptimistic } from "./optimistic";
import type { OutboxCommand, OutboxItem } from "./types";

type OutboxRow = {
  id: string;
  account_id: string;
  command: OutboxCommand;
  idempotency_key: string;
  status: OutboxItem["status"];
  attempts: number;
  last_error: string | null;
  next_attempt_at: Date;
  created_at: Date;
  updated_at: Date;
};

function mapRow(row: OutboxRow): OutboxItem {
  return {
    id: row.id,
    accountId: row.account_id,
    command: row.command,
    idempotencyKey: row.idempotency_key,
    status: row.status,
    attempts: row.attempts,
    lastError: row.last_error,
    nextAttemptAt: row.next_attempt_at.toISOString(),
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

export async function findByIdempotencyKey(
  accountId: AccountId,
  idempotencyKey: string,
  client?: PoolClient,
): Promise<OutboxItem | null> {
  const runner = client ?? db();
  const r = await runner.query<OutboxRow>(
    `select id, account_id, command, idempotency_key, status, attempts,
            last_error, next_attempt_at, created_at, updated_at
       from seer.outbox
      where account_id = $1 and idempotency_key = $2`,
    [accountId, idempotencyKey],
  );
  const row = r.rows[0];
  return row ? mapRow(row) : null;
}

/**
 * Capture the current corpus state for a conversation before applying a patch.
 */
export async function snapshotConversation(
  client: PoolClient,
  accountId: AccountId,
  conversationId: string,
): Promise<OutboxCommand["previous"] | null> {
  const r = await client.query<{ folders: string[]; is_unread: boolean }>(
    `select folders, is_unread
       from seer.conversations
      where id = $1 and account_id = $2`,
    [conversationId, accountId],
  );
  const row = r.rows[0];
  if (!row) return null;
  return { folders: [...row.folders], isUnread: row.is_unread };
}

/**
 * Apply an optimistic corpus patch and enqueue the provider command in one
 * transaction. Replays with the same idempotency key return the existing row.
 */
export async function enqueueOptimistic(
  accountId: AccountId,
  command: OutboxCommand,
  idempotencyKey: string,
): Promise<OutboxItem> {
  return inTransaction(async (client) => {
    const existing = await findByIdempotencyKey(accountId, idempotencyKey, client);
    if (existing) return existing;

    await applyOptimistic(client, accountId, command);
    const r = await client.query<OutboxRow>(
      `insert into seer.outbox (account_id, command, idempotency_key)
       values ($1, $2::jsonb, $3)
       returning id, account_id, command, idempotency_key, status, attempts,
                 last_error, next_attempt_at, created_at, updated_at`,
      [accountId, JSON.stringify(command), idempotencyKey],
    );
    return mapRow(r.rows[0]);
  });
}

/**
 * Cancel a pending outbox row and revert its optimistic patch. No provider call
 * is made — the mutation never left the queue.
 */
export async function cancelPending(
  accountId: AccountId,
  outboxId: string,
): Promise<boolean> {
  return inTransaction(async (client) => {
    const r = await client.query<OutboxRow>(
      `update seer.outbox
          set status = 'cancelled', updated_at = now()
        where id = $1
          and account_id = $2
          and status = 'pending'
      returning id, account_id, command, idempotency_key, status, attempts,
                last_error, next_attempt_at, created_at, updated_at`,
      [outboxId, accountId],
    );
    const row = r.rows[0];
    if (!row) return false;
    await revertOptimistic(client, accountId, row.command);
    return true;
  });
}
