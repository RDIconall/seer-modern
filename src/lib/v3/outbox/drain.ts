import type { PoolClient } from "pg";
import { inTransaction } from "@/lib/v2/db/transaction";
import { recordEvent } from "@/lib/v2/commands/repository";
import { providerConversationId } from "@/lib/v2/commands/repository";
import type { AccountId } from "@/lib/v2/db/types";
import type { MailProvider, MutationAction } from "@/lib/v2/providers/types";
import { revertOptimistic } from "./optimistic";
import type { DrainReport, OutboxCommand, OutboxItem } from "./types";

export const MAX_OUTBOX_ATTEMPTS = 5;

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

export function backoffMs(attempt: number): number {
  return Math.min(60_000, 1000 * 2 ** attempt);
}

function providerAction(type: OutboxCommand["type"]): MutationAction {
  switch (type) {
    case "archive":
      return "archive";
    case "trash":
      return "trash";
    case "restore":
      return "restore";
    case "markUnread":
      return "markUnread";
    default: {
      const _exhaustive: never = type;
      throw new Error(`unknown mutation ${JSON.stringify(_exhaustive)}`);
    }
  }
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
                o.attempts, o.last_error, o.next_attempt_at, o.created_at, o.updated_at`,
    [accountId, limit],
  );
  return r.rows.map(mapRow);
}

async function markDone(client: PoolClient, outboxId: string): Promise<void> {
  await client.query(
    `update seer.outbox
        set status = 'done', last_error = null, updated_at = now()
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

async function markFailed(
  client: PoolClient,
  accountId: AccountId,
  item: OutboxItem,
  error: string,
): Promise<void> {
  await client.query(
    `update seer.outbox
        set status = 'failed',
            attempts = $2,
            last_error = $3,
            updated_at = now()
      where id = $1`,
    [item.id, item.attempts + 1, error.slice(0, 500)],
  );
  await revertOptimistic(client, accountId, item.command);
  await recordEvent(
    accountId,
    "outbox_failed",
    {
      outboxId: item.id,
      command: item.command,
      error: error.slice(0, 500),
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
    const attempts = item.attempts + 1;
    if (attempts >= MAX_OUTBOX_ATTEMPTS) {
      await inTransaction(async (client) => {
        await markFailed(client, accountId, { ...item, attempts: item.attempts }, "conversation not found");
      });
      return "failed";
    }
    await inTransaction(async (client) => {
      await scheduleRetry(client, item.id, attempts, "conversation not found");
    });
    return "retried";
  }

  try {
    const receipt = await provider.mutateConversation(
      providerId,
      providerAction(item.command.type),
      item.idempotencyKey,
    );
    if (receipt.failed.length > 0) {
      const error = `provider partial failure: ${receipt.failed.length} message(s) failed`;
      const attempts = item.attempts + 1;
      if (attempts >= MAX_OUTBOX_ATTEMPTS) {
        await inTransaction(async (client) => {
          await markFailed(client, accountId, item, error);
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
    const attempts = item.attempts + 1;
    if (attempts >= MAX_OUTBOX_ATTEMPTS) {
      await inTransaction(async (client) => {
        await markFailed(client, accountId, item, error);
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
 * Drain pending outbox rows for one account oldest-first. Claims rows with
 * `for update skip locked`, calls the provider once per row with the stored
 * idempotency key, and retries transient failures with bounded backoff.
 */
export async function drainOutbox(
  accountId: AccountId,
  provider: MailProvider,
  opts: { limit?: number } = {},
): Promise<DrainReport> {
  const limit = opts.limit ?? 10;
  const report: DrainReport = { processed: 0, done: 0, failed: 0, retried: 0 };

  const claimed = await inTransaction(async (client) =>
    claimPending(client, accountId, limit),
  );

  for (const item of claimed) {
    report.processed += 1;
    const outcome = await processOne(accountId, provider, item);
    if (outcome === "done") report.done += 1;
    else if (outcome === "failed") report.failed += 1;
    else report.retried += 1;
  }

  return report;
}