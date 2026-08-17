import type { PoolClient } from "pg";
import { inTransaction } from "@/lib/v2/db/transaction";
import { db } from "@/lib/v2/db/pool";
import { recordEvent } from "@/lib/v2/commands/repository";
import type { AccountId } from "@/lib/v2/db/types";
import {
  applyOptimistic,
  computeExpected,
  lockConversation,
  revertOptimistic,
} from "./optimistic";
import type { EnqueueInput, OutboxCommand, OutboxItem } from "./types";

type OutboxRow = {
  id: string;
  account_id: string;
  command: OutboxCommand;
  idempotency_key: string;
  status: OutboxItem["status"];
  attempts: number;
  last_error: string | null;
  reconcile_needed: boolean;
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
    reconcileNeeded: row.reconcile_needed,
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
            last_error, reconcile_needed, next_attempt_at, created_at, updated_at
       from seer.outbox
      where account_id = $1 and idempotency_key = $2`,
    [accountId, idempotencyKey],
  );
  const row = r.rows[0];
  return row ? mapRow(row) : null;
}

/**
 * Apply an optimistic corpus patch and enqueue the provider command in one
 * transaction. Concurrent callers with the same idempotency key get the
 * existing row; the optimistic patch is applied exactly once.
 */
export async function enqueueOptimistic(
  accountId: AccountId,
  input: EnqueueInput,
  idempotencyKey: string,
): Promise<OutboxItem> {
  return inTransaction(async (client) => {
    const locked = await lockConversation(client, accountId, input.conversationId);
    if (!locked) throw new Error("conversation not found");

    const previous = { folders: [...locked.folders], isUnread: locked.isUnread };
    const expected = computeExpected(input.type, previous);
    const command: OutboxCommand = {
      type: input.type,
      conversationId: input.conversationId,
      previous,
      expected,
    };

    const inserted = await client.query<OutboxRow>(
      `insert into seer.outbox (account_id, command, idempotency_key)
       values ($1, $2::jsonb, $3)
       on conflict (account_id, idempotency_key) do nothing
       returning id, account_id, command, idempotency_key, status, attempts,
                 last_error, reconcile_needed, next_attempt_at, created_at, updated_at`,
      [accountId, JSON.stringify(command), idempotencyKey],
    );

    if ((inserted.rowCount ?? 0) === 0) {
      const existing = await findByIdempotencyKey(accountId, idempotencyKey, client);
      if (!existing) throw new Error("outbox idempotency conflict without row");
      return existing;
    }

    await applyOptimistic(client, accountId, command);
    return mapRow(inserted.rows[0]);
  });
}

/**
 * Cancel a pending outbox row and revert its optimistic patch when the corpus
 * still matches the command's expected state.
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
                last_error, reconcile_needed, next_attempt_at, created_at, updated_at`,
      [outboxId, accountId],
    );
    const row = r.rows[0];
    if (!row) return false;

    const outcome = await revertOptimistic(client, accountId, row.command);
    if (outcome === "conflict") {
      await recordEvent(
        accountId,
        "outbox_reconcile_needed",
        {
          outboxId: row.id,
          reason: "cancel_revert_conflict",
          command: row.command,
        },
        row.idempotency_key,
        client,
      );
    }
    return true;
  });
}
