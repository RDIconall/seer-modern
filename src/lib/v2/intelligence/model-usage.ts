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
  q: Queryable = db(),
): Promise<boolean> {
  const defaultLimit = tier === "fast" ? 1000 : 200;
  const envName =
    tier === "fast"
      ? "SEER_FAST_DAILY_CALL_LIMIT"
      : "SEER_STRONG_DAILY_CALL_LIMIT";
  const limit = Number(process.env[envName] ?? defaultLimit);
  if (!Number.isFinite(limit) || limit <= 0) return false;
  const result = await q.query<{ n: number }>(
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
  q: Queryable = db(),
): Promise<boolean> {
  const cap = Number(process.env.SEER_DAILY_SPEND_LIMIT_USD ?? 0);
  if (!Number.isFinite(cap) || cap <= 0) return true;
  const result = await q.query<{ spend: string }>(
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
): Promise<boolean> {
  if (!(await withinDailyCallLimit(accountId, tier))) return false;
  return withinDailySpendLimit(accountId);
}

/** A paid call was refused because the account is over its daily budget. */
export class ModelBudgetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ModelBudgetError";
  }
}

export type ModelReservation = { usageId: string };

/**
 * Check the daily budget and claim one call slot in a single step. The usage
 * row is written before the paid call, under a per-account advisory lock, so
 * concurrent requests cannot all pass the check before any row exists. With
 * `exclusive`, a second call carrying that reason is refused while the first
 * is still in flight, which keeps the spend cap (known only after a call
 * returns) from being overshot by parallel requests.
 */
export async function reserveModelCall(input: {
  accountId: AccountId;
  tier: "fast" | "strong";
  model: string;
  escalationReasons: string[];
  exclusive?: { reason: string; staleAfterMs: number };
}): Promise<ModelReservation> {
  return inTransaction(async (client) => {
    await client.query(
      `select pg_advisory_xact_lock(hashtextextended($1, 0))`,
      [`seer.model_usage:${input.accountId}`],
    );
    if (!(await withinDailyCallLimit(input.accountId, input.tier, client))) {
      throw new ModelBudgetError(
        `${input.tier} daily model-call limit reached for this mailbox`,
      );
    }
    if (!(await withinDailySpendLimit(input.accountId, client))) {
      throw new ModelBudgetError("daily model spend cap reached for this mailbox");
    }
    if (input.exclusive) {
      const running = await client.query(
        `select 1 from seer.model_usage
          where account_id = $1
            and provider_metadata->>'reservation' = 'pending'
            and $2 = any(escalation_reasons)
            and created_at > now() - make_interval(secs => $3)
          limit 1`,
        [
          input.accountId,
          input.exclusive.reason,
          input.exclusive.staleAfterMs / 1000,
        ],
      );
      if (running.rowCount) {
        throw new ModelBudgetError(
          "daily budget is checked one call at a time; another request for this mailbox is still running",
        );
      }
    }
    const row = await client.query<{ id: string }>(
      `insert into seer.model_usage
         (account_id, tier, model, escalation_reasons, provider_metadata)
       values ($1, $2, $3, $4, '{"reservation":"pending"}'::jsonb)
       returning id`,
      [input.accountId, input.tier, input.model, input.escalationReasons],
    );
    return { usageId: row.rows[0].id };
  });
}

/** Fill a reserved row with what the call actually used and cost. */
export async function completeModelCall(
  reservation: ModelReservation,
  usage: Omit<
    ModelUsageRecord,
    "accountId" | "conversationId" | "tier" | "model" | "escalationReasons"
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
            cost_usd = $9,
            provider_metadata = $10::jsonb
      where id = $1`,
    [
      reservation.usageId,
      usage.latencyMs,
      usage.inputTokens ?? null,
      usage.outputTokens ?? null,
      usage.reasoningTokens ?? null,
      usage.cachedInputTokens ?? null,
      usage.totalTokens ?? null,
      usage.gatewayGenerationId ?? null,
      usage.costUsd ?? null,
      JSON.stringify(usage.providerMetadata ?? {}),
    ],
  );
}

/**
 * A call that was attempted keeps its slot: the provider may still bill a
 * failed or timed-out generation. A call that never started gives it back.
 */
export async function releaseModelCall(
  reservation: ModelReservation,
  outcome: { attempted: boolean; latencyMs: number },
): Promise<void> {
  if (!outcome.attempted) {
    await db().query(`delete from seer.model_usage where id = $1`, [
      reservation.usageId,
    ]);
    return;
  }
  await db().query(
    `update seer.model_usage
        set latency_ms = $2,
            provider_metadata = '{"reservation":"failed"}'::jsonb
      where id = $1`,
    [reservation.usageId, outcome.latencyMs],
  );
}

