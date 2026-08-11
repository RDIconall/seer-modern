import type { PoolClient } from "pg";
import { db } from "../db/pool";
import type { AccountId } from "../db/types";
import { findByIdempotencyKey } from "@/lib/v3/outbox/repository";
import type { CommandResult } from "./types";

/**
 * Idempotency and audit for commands. A receipt keyed by (account, idempotency
 * key) makes replays safe: a retried or double-tapped command returns its first
 * result instead of acting twice. Events are the append-only audit log.
 */

export async function existingReceipt(
  accountId: AccountId,
  idempotencyKey: string,
): Promise<CommandResult | null> {
  const r = await db().query<{ result: CommandResult }>(
    "select result from seer.command_receipts where account_id = $1 and idempotency_key = $2",
    [accountId, idempotencyKey],
  );
  const row = r.rows[0];
  if (row) return { ...row.result, replayed: true };

  // A concurrent enqueue may have committed the outbox row before its receipt.
  const outbox = await findByIdempotencyKey(accountId, idempotencyKey);
  if (!outbox) return null;
  return {
    ok: true,
    replayed: true,
    outboxId: outbox.id,
    optimistic: true,
  };
}

export async function saveReceipt(
  accountId: AccountId,
  idempotencyKey: string,
  commandType: string,
  result: CommandResult,
  client?: PoolClient,
): Promise<void> {
  const runner = client ?? db();
  await runner.query(
    `insert into seer.command_receipts (account_id, idempotency_key, command_type, result)
       values ($1, $2, $3, $4::jsonb)
       on conflict (account_id, idempotency_key) do nothing`,
    [accountId, idempotencyKey, commandType, JSON.stringify(result)],
  );
}

export async function recordEvent(
  accountId: AccountId,
  kind: string,
  payload: Record<string, unknown>,
  idempotencyKey: string | null,
  client?: PoolClient,
): Promise<void> {
  const runner = client ?? db();
  await runner.query(
    `insert into seer.events (account_id, kind, idempotency_key, payload)
       values ($1, $2, $3, $4::jsonb)
       on conflict (account_id, idempotency_key) do nothing`,
    [accountId, kind, idempotencyKey, JSON.stringify(payload)],
  );
}

export async function providerConversationId(
  accountId: AccountId,
  conversationId: string,
): Promise<string | null> {
  const r = await db().query<{ provider_conversation_id: string }>(
    "select provider_conversation_id from seer.conversations where id = $1 and account_id = $2",
    [conversationId, accountId],
  );
  return r.rows[0]?.provider_conversation_id ?? null;
}

/**
 * The current decision for a conversation, used to authorize a delete: the
 * signed token must map to THIS decision and its home must still be delete.
 */
export async function currentDeleteDecision(
  accountId: AccountId,
  conversationId: string,
): Promise<{ decisionId: string; home: string } | null> {
  const r = await db().query<{ id: string; home: string }>(
    "select id, home from seer.conversation_decisions where account_id = $1 and conversation_id = $2 and is_current",
    [accountId, conversationId],
  );
  const row = r.rows[0];
  if (!row) return null;
  return { decisionId: row.id, home: row.home };
}
