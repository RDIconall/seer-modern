import type { PoolClient } from "pg";
import { inTransaction } from "@/lib/v2/db/transaction";
import { recordEvent } from "@/lib/v2/commands/repository";
import { providerConversationId } from "@/lib/v2/commands/repository";
import type { AccountId } from "@/lib/v2/db/types";
import type { MailProvider, MutationReceipt } from "@/lib/v2/providers/types";
import { revertOptimistic } from "./optimistic";
import { classifyDrainError } from "./retry";
import type { DrainReport, OutboxCommand, OutboxItem } from "./types";

export const MAX_OUTBOX_ATTEMPTS = 5;
export const INFLIGHT_LEASE_MS = 5 * 60 * 1000;

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

export type DrainOptions = {
  limit?: number;
  leaseMs?: number;
  now?: () => Date;
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

export function backoffMs(attempt: number): number {
  return Math.min(60_000, 1000 * 2 ** attempt);
}

function providerAction(
  type: OutboxCommand["type"],
): Parameters<MailProvider["mutateConversation"]>[1] {
  return type;
}

async function reclaimStaleInflight(
  client: PoolClient,
  accountId: AccountId,
  leaseMs: number,
): Promise<number> {
  const r = await client.query<{ id: string }>(
    `update seer.outbox
        set status = 'pending',
            attempts = attempts + 1,
            last_error = coalesce(last_error, '') || ' [reclaimed stale inflight]',
            next_attempt_at = now(),
            updated_at = now()
      where account_id = $1
        and status = 'inflight'
        and updated_at < now() - ($2::int * interval '1 millisecond')
      returning id`,
    [accountId, leaseMs],
  );
  return r.rowCount ?? 0;
}

async function claimPending(
  client: PoolClient,
  accountId: AccountId,
  limit: number,
): Promise<OutboxItem[]> {
  const r = await client.query<OutboxRow>(
    `with claimed as (
       select id
         from seer.outbox
        where account_id = $1
          and status = 'pending'
          and next_attempt_at <= now()
        order by created_at asc
        limit $2
        for update skip locked
     )
     update seer.outbox o
        set status = 'inflight', updated_at = now()
       from claimed c
      where o.id = c.id
      returning o.id, o.account_id, o.command, o.idempotency_key, o.status,
                o.attempts, o.last_error, o.reconcile_needed, o.next_attempt_at,
                o.created_at, o.updated_at`,
    [accountId, limit],
  );
  return r.rows.map(mapRow);
}

async function markDone(client: PoolClient, outboxId: string): Promise<void> {
  await client.query(
    `update seer.outbox
        set status = 'done', last_error = null, reconcile_needed = false, updated_at = now()
      where id = $1`,
    [outboxId],
  );
}

async function scheduleRetry(
  client: PoolClient,
  outboxId: string,
  attempts: number,
  error: string,
): Promise<void> {
  const delayMs = backoffMs(attempts - 1);
  await client.query(
    `update seer.outbox
        set status = 'pending',
            attempts = $2,
            last_error = $3,
            next_attempt_at = now() + ($4::int * interval '1 millisecond'),
            updated_at = now()
      where id = $1`,
    [outboxId, attempts, error.slice(0, 500), delayMs],
  );
}

type PermanentFailOpts = {
  receipt?: MutationReceipt;
  revert?: boolean;
  needsReconcile: boolean;
};

async function markPermanentFailed(
  client: PoolClient,
  accountId: AccountId,
  item: OutboxItem,
  error: string,
  opts: PermanentFailOpts,
): Promise<void> {
  const revert = opts.revert ?? true;
  await client.query(
    `update seer.outbox
        set status = 'failed',
            attempts = attempts + 1,
            last_error = $2,
            reconcile_needed = $3,
            updated_at = now()
      where id = $1`,
    [item.id, error.slice(0, 500), opts.needsReconcile],
  );

  let revertOutcome: "reverted" | "conflict" | "skipped" = "skipped";
  if (revert && (!opts.receipt || opts.receipt.processed.length === 0)) {
    revertOutcome = await revertOptimistic(client, accountId, item.command);
  }

  const kind =
    opts.needsReconcile || revertOutcome === "conflict"
      ? "outbox_reconcile_needed"
      : "outbox_failed";

  await recordEvent(
    accountId,
    kind,
    {
      outboxId: item.id,
      command: item.command,
      error: error.slice(0, 500),
      receipt: opts.receipt
        ? { processed: opts.receipt.processed, failed: opts.receipt.failed }
        : undefined,
      revertOutcome,
      needsReconcile: opts.needsReconcile,
    },
    item.idempotencyKey,
    client,
  );
}

async function processOne(
  accountId: AccountId,
  provider: MailProvider,
  item: OutboxItem,
): Promise<"done" | "retried" | "failed"> {
  const providerId = await providerConversationId(
    accountId,
    item.command.conversationId,
  );
  if (!providerId) {
    await inTransaction(async (client) => {
      await markPermanentFailed(client, accountId, item, "conversation not found", {
        needsReconcile: false,
        revert: true,
      });
    });
    return "failed";
  }

  try {
    const receipt = await provider.mutateConversation(
      providerId,
      providerAction(item.command.type),
      item.idempotencyKey,
    );

    if (receipt.failed.length > 0) {
      const error = `provider partial failure: ${receipt.processed.length} processed, ${receipt.failed.length} failed`;
      if (receipt.processed.length > 0) {
        await inTransaction(async (client) => {
          await markPermanentFailed(client, accountId, item, error, {
            receipt,
            revert: false,
            needsReconcile: true,
          });
        });
        return "failed";
      }
      const attempts = item.attempts + 1;
      if (attempts >= MAX_OUTBOX_ATTEMPTS) {
        await inTransaction(async (client) => {
          await markPermanentFailed(client, accountId, item, error, {
            receipt,
            revert: true,
            needsReconcile: false,
          });
        });
        return "failed";
      }
      await inTransaction(async (client) => {
        await scheduleRetry(client, item.id, attempts, error);
      });
      return "retried";
    }

    await inTransaction(async (client) => {
      await markDone(client, item.id);
    });
    return "done";
  } catch (err) {
    const error = err instanceof Error ? err.message : "provider mutation failed";
    const disposition = classifyDrainError(err);

    if (disposition === "permanent") {
      await inTransaction(async (client) => {
        await markPermanentFailed(client, accountId, item, error, {
          needsReconcile: false,
          revert: true,
        });
      });
      return "failed";
    }

    if (disposition === "reconcile") {
      await inTransaction(async (client) => {
        await markPermanentFailed(client, accountId, item, error, {
          needsReconcile: true,
          revert: false,
        });
      });
      return "failed";
    }

    const attempts = item.attempts + 1;
    if (attempts >= MAX_OUTBOX_ATTEMPTS) {
      await inTransaction(async (client) => {
        await markPermanentFailed(client, accountId, item, error, {
          needsReconcile: false,
          revert: true,
        });
      });
      return "failed";
    }
    await inTransaction(async (client) => {
      await scheduleRetry(client, item.id, attempts, error);
    });
    return "retried";
  }
}

/**
 * Drain pending outbox rows for one account oldest-first. Reclaims stale
 * inflight leases, claims with `for update skip locked`, and retries transient
 * failures with bounded exponential backoff.
 */
export async function drainOutbox(
  accountId: AccountId,
  provider: MailProvider,
  opts: DrainOptions = {},
): Promise<DrainReport> {
  const limit = opts.limit ?? 10;
  const leaseMs = opts.leaseMs ?? INFLIGHT_LEASE_MS;
  const report: DrainReport = {
    processed: 0,
    done: 0,
    failed: 0,
    retried: 0,
    reclaimed: 0,
  };

  const { reclaimed, claimed } = await inTransaction(async (client) => {
    const reclaimedCount = await reclaimStaleInflight(client, accountId, leaseMs);
    const rows = await claimPending(client, accountId, limit);
    return { reclaimed: reclaimedCount, claimed: rows };
  });
  report.reclaimed = reclaimed;

  for (const item of claimed) {
    report.processed += 1;
    const outcome = await processOne(accountId, provider, item);
    if (outcome === "done") report.done += 1;
    else if (outcome === "failed") report.failed += 1;
    else report.retried += 1;
  }

  return report;
}
