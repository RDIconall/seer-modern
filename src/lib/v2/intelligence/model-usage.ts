import type { Pool, PoolClient } from "pg";
import { db } from "../db/pool";
import { inTransaction } from "../db/transaction";
import type { AccountId, ConversationId } from "../db/types";

type Queryable = Pool | PoolClient;

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
  await insertModelUsage(record, db());
}

async function insertModelUsage(
  record: ModelUsageRecord,
  client: Queryable,
): Promise<string | undefined> {
  const result = await client.query<{ id: string }>(
    `insert into seer.model_usage
       (account_id, conversation_id, tier, model, escalation_reasons,
        latency_ms, input_tokens, output_tokens, reasoning_tokens,
        cached_input_tokens, total_tokens, gateway_generation_id, cost_usd,
        provider_metadata)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14::jsonb)
     returning id`,
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
  return result.rows[0]?.id;
}

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

export type UsageReservation =
  | { ok: true; id: string }
  | { ok: false; reason: "daily_budget" | "rate_limit" };

/**
 * Check the daily ceiling and record the call in one step, before the
 * provider is contacted. The per-account advisory lock serializes concurrent
 * reservations, so parallel requests cannot all pass a ceiling that only has
 * room for one. `window` optionally caps how many rows carrying any of its
 * tags this account may add in the trailing `seconds`.
 */
export async function reserveModelUsage(
  record: Omit<ModelUsageRecord, "latencyMs">,
  window?: { tags: string[]; seconds: number; limit: number },
): Promise<UsageReservation> {
  return inTransaction(async (client) => {
    await client.query(
      `select pg_advisory_xact_lock(hashtext('seer.model_usage'), hashtext($1))`,
      [record.accountId],
    );
    if (!(await withinDailyBudget(record.accountId, record.tier, client))) {
      return { ok: false, reason: "daily_budget" } as const;
    }
    if (window) {
      if (!Number.isFinite(window.limit) || window.limit <= 0) {
        return { ok: false, reason: "rate_limit" } as const;
      }
      const recent = await client.query<{ n: number }>(
        `select count(*)::int as n
           from seer.model_usage
          where account_id = $1
            and escalation_reasons && $2::text[]
            and created_at > clock_timestamp() - make_interval(secs => $3)`,
        [record.accountId, window.tags, window.seconds],
      );
      if ((recent.rows[0]?.n ?? 0) >= window.limit) {
        return { ok: false, reason: "rate_limit" } as const;
      }
    }
    const id = await insertModelUsage({ ...record, latencyMs: 0 }, client);
    if (!id) throw new Error("model usage reservation was not recorded");
    return { ok: true, id } as const;
  });
}

/** Fill in what a reserved call actually cost once the provider answered. */
export async function settleModelUsage(
  id: string,
  outcome: Pick<
    ModelUsageRecord,
    | "latencyMs"
    | "inputTokens"
    | "outputTokens"
    | "reasoningTokens"
    | "cachedInputTokens"
    | "totalTokens"
    | "gatewayGenerationId"
    | "costUsd"
  >,
): Promise<void> {
  await db().query(
    `update seer.model_usage
        set latency_ms = $2,
            input_tokens = $3,
            output_tokens = $4,
            reasoning_tokens = $5,
            cached_input_tokens = $6,
            total_tokens = $7,
            gateway_generation_id = $8,
            cost_usd = $9
      where id = $1`,
    [
      id,
      outcome.latencyMs,
      outcome.inputTokens ?? null,
      outcome.outputTokens ?? null,
      outcome.reasoningTokens ?? null,
      outcome.cachedInputTokens ?? null,
      outcome.totalTokens ?? null,
      outcome.gatewayGenerationId ?? null,
      outcome.costUsd ?? null,
    ],
  );
}
