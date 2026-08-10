import { db } from "../db/pool";
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

/** Hard request ceilings: a runaway loop stops before it becomes a bill. */
export async function withinDailyCallLimit(
  accountId: AccountId,
  tier: "fast" | "strong",
): Promise<boolean> {
  const defaultLimit = tier === "fast" ? 1000 : 200;
  const envName =
    tier === "fast"
      ? "SEER_FAST_DAILY_CALL_LIMIT"
      : "SEER_STRONG_DAILY_CALL_LIMIT";
  const limit = Number(process.env[envName] ?? defaultLimit);
  if (!Number.isFinite(limit) || limit <= 0) return false;
  const result = await db().query<{ n: number }>(
    `select count(*)::int as n
       from seer.model_usage
      where account_id = $1 and tier = $2
        and created_at >= date_trunc('day', now())`,
    [accountId, tier],
  );
  return (result.rows[0]?.n ?? 0) < limit;
}

