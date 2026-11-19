import type { PoolClient } from "pg";
import { db } from "../db/pool";
import { inTransaction } from "../db/transaction";
import type { AccountId, ConversationId } from "../db/types";

/** One model invocation — enough detail to reconcile with AI Gateway spend. */
export type ModelUsageRecord = {
  accountId: AccountId;
  conversationId?: ConversationId;
  tier: "fast" | "strong";
  model: string;
  escalationReasons: string[];
  latencyMs: number;
  inputTokens?: number;
  outputTokens?: number;
  reasoningTokens?: number;
  cachedInputTokens?: number;
  totalTokens?: number;
  gatewayGenerationId?: string;
  costUsd?: number;
  providerMetadata?: Record<string, unknown>;
};

/**
 * Usage telemetry must not break a read if the telemetry write itself fails.
 * The Gateway still has the generation by ID; the app logs the persistence
 * failure so operations can repair it.
 */
export async function recordModelUsage(
  record: ModelUsageRecord,
): Promise<void> {
  await db().query(
    `insert into seer.model_usage
       (account_id, conversation_id, tier, model, escalation_reasons,
        latency_ms, input_tokens, output_tokens, reasoning_tokens,
        cached_input_tokens, total_tokens, gateway_generation_id, cost_usd,
        provider_metadata)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14::jsonb)`,
    [
      record.accountId,
      record.conversationId ?? null,
      record.tier,
      record.model,
      record.escalationReasons,
      record.latencyMs,
      record.inputTokens ?? null,
      record.outputTokens ?? null,
      record.reasoningTokens ?? null,
      record.cachedInputTokens ?? null,
      record.totalTokens ?? null,
      record.gatewayGenerationId ?? null,
      record.costUsd ?? null,
      JSON.stringify(record.providerMetadata ?? {}),
    ],
  );
}

type Queryable = Pick<PoolClient, "query">;

/** Hard request ceilings: a runaway loop stops before it becomes a bill. */
export async function withinDailyCallLimit(
  accountId: AccountId,
  tier: "fast" | "strong",
  client: Queryable = db(),
): Promise<boolean> {
  const defaultLimit = tier === "fast" ? 1000 : 200;
  const envName =
    tier === "fast"
      ? "SEER_FAST_DAILY_CALL_LIMIT"
      : "SEER_STRONG_DAILY_CALL_LIMIT";
  const limit = Number(process.env[envName] ?? defaultLimit);
  if (!Number.isFinite(limit) || limit <= 0) return false;
  const result = await client.query<{ n: number }>(
    `select count(*)::int as n
       from seer.model_usage
      where account_id = $1 and tier = $2
        and created_at >= date_trunc('day', now())`,
    [accountId, tier],
  );
  return (result.rows[0]?.n ?? 0) < limit;
}

/** Dollar ceiling across both tiers. 0 / unset means no spend cap. */
export async function withinDailySpendLimit(
  accountId: AccountId,
  client: Queryable = db(),
): Promise<boolean> {
  const cap = Number(process.env.SEER_DAILY_SPEND_LIMIT_USD ?? 0);
  if (!Number.isFinite(cap) || cap <= 0) return true;
  const result = await client.query<{ spend: string }>(
    `select coalesce(sum(cost_usd), 0)::text as spend
       from seer.model_usage
      where account_id = $1
        and created_at >= date_trunc('day', now())`,
    [accountId],
  );
  return Number(result.rows[0]?.spend ?? 0) < cap;
}

export async function withinDailyBudget(
  accountId: AccountId,
  tier: "fast" | "strong",
  client: Queryable = db(),
): Promise<boolean> {
  if (!(await withinDailyCallLimit(accountId, tier, client))) return false;
  return withinDailySpendLimit(accountId, client);
}

/**
 * Claim one call against the daily budget before the call is made. The budget
 * check and the usage row commit together under a per-account lock, so
 * concurrent callers cannot all pass the check and then spend the same last
 * slot. Returns the usage row's id, or null when the budget is spent. A call
 * that later throws keeps its row: the request may still have been billed.
 */
export async function reserveModelCall(record: {
  accountId: AccountId;
  conversationId?: ConversationId;
  tier: "fast" | "strong";
  model: string;
  escalationReasons: string[];
}): Promise<string | null> {
  return inTransaction(async (client) => {
    await client.query(
      "select pg_advisory_xact_lock(hashtext('seer.model_usage:' || $1::text))",
      [record.accountId],
    );
    if (!(await withinDailyBudget(record.accountId, record.tier, client))) {
      return null;
    }
    const row = await client.query<{ id: string }>(
      `insert into seer.model_usage
         (account_id, conversation_id, tier, model, escalation_reasons)
       values ($1, $2, $3, $4, $5)
       returning id`,
      [
        record.accountId,
        record.conversationId ?? null,
        record.tier,
        record.model,
        record.escalationReasons,
      ],
    );
    return row.rows[0].id;
  });
}

export type ModelCallSettlement = {
  latencyMs: number;
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  providerMetadata?: Record<string, unknown>;
};

/** Fill in what a reserved call actually used, including its Gateway cost. */
export async function settleModelCall(
  reservationId: string,
  usage: ModelCallSettlement,
): Promise<void> {
  const gateway = usage.providerMetadata?.gateway;
  const meta =
    gateway && typeof gateway === "object"
      ? (gateway as Record<string, unknown>)
      : {};
  const cost = Number(meta.cost);
  await db().query(
    `update seer.model_usage
        set latency_ms = $2,
            input_tokens = $3,
            output_tokens = $4,
            total_tokens = $5,
            gateway_generation_id = $6,
            cost_usd = $7,
            provider_metadata = $8::jsonb
      where id = $1`,
    [
      reservationId,
      usage.latencyMs,
      usage.inputTokens ?? null,
      usage.outputTokens ?? null,
      usage.totalTokens ?? null,
      typeof meta.generationId === "string" ? meta.generationId : null,
      meta.cost != null && Number.isFinite(cost) ? cost : null,
      JSON.stringify(usage.providerMetadata ?? {}),
    ],
  );
}

