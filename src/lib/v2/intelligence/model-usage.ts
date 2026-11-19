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

function dailyCallLimit(tier: "fast" | "strong"): number {
  const defaultLimit = tier === "fast" ? 1000 : 200;
  const envName =
    tier === "fast"
      ? "SEER_FAST_DAILY_CALL_LIMIT"
      : "SEER_STRONG_DAILY_CALL_LIMIT";
  const limit = Number(process.env[envName] ?? defaultLimit);
  return Number.isFinite(limit) && limit > 0 ? limit : 0;
}

/** 0 means no spend cap. */
function dailySpendCap(): number {
  const cap = Number(process.env.SEER_DAILY_SPEND_LIMIT_USD ?? 0);
  return Number.isFinite(cap) && cap > 0 ? cap : 0;
}

/** Hard request ceilings: a runaway loop stops before it becomes a bill. */
export async function withinDailyCallLimit(
  accountId: AccountId,
  tier: "fast" | "strong",
): Promise<boolean> {
  const limit = dailyCallLimit(tier);
  if (limit <= 0) return false;
  const result = await db().query<{ n: number }>(
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
): Promise<boolean> {
  const cap = dailySpendCap();
  if (cap <= 0) return true;
  const result = await db().query<{ spend: string }>(
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

/**
 * The account a mailbox's model spend is charged to, for callers that know
 * only the mailbox address. Null when no account holds it.
 */
export async function budgetAccountForMailbox(
  email: string,
): Promise<AccountId | null> {
  const result = await db().query<{ id: AccountId }>(
    `select id from seer.mail_accounts
      where email = $1
      order by provider, created_at
      limit 1`,
    [email.toLowerCase().trim()],
  );
  return result.rows[0]?.id ?? null;
}

/**
 * Take one slot of the mailbox's daily budget before the model is called.
 *
 * Checking the budget and recording usage afterwards lets parallel calls all
 * pass on the same count. Here the check and the usage row are one step under
 * a per-account lock, so every caller sees the slots taken before it. Returns
 * the usage row to settle once the call ends, or null when the budget is spent.
 */
export async function reserveModelCall(input: {
  accountId: AccountId;
  tier: "fast" | "strong";
  model: string;
  escalationReasons: string[];
}): Promise<string | null> {
  const limit = dailyCallLimit(input.tier);
  if (limit <= 0) return null;
  const client = await db().connect();
  try {
    await client.query("begin");
    await client.query(
      `select pg_advisory_xact_lock(hashtextextended('seer.model_usage:' || $1::text, 0))`,
      [input.accountId],
    );
    const result = await client.query<{ id: string }>(
      `insert into seer.model_usage (account_id, tier, model, escalation_reasons)
       select $1::uuid, $2::text, $3::text, $4::text[]
        where (select count(*)
                 from seer.model_usage
                where account_id = $1::uuid and tier = $2::text
                  and created_at >= date_trunc('day', now())) < $5::int
          and ($6::numeric <= 0
               or (select coalesce(sum(cost_usd), 0)
                     from seer.model_usage
                    where account_id = $1::uuid
                      and created_at >= date_trunc('day', now())) < $6::numeric)
       returning id`,
      [
        input.accountId,
        input.tier,
        input.model,
        input.escalationReasons,
        limit,
        dailySpendCap(),
      ],
    );
    await client.query("commit");
    return result.rows[0]?.id ?? null;
  } catch (error) {
    await client.query("rollback").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

/** Fill in a reserved usage row with what the call actually cost. */
export async function settleModelCall(
  usageId: string,
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
    | "providerMetadata"
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
      usageId,
      Math.max(0, Math.round(outcome.latencyMs)),
      outcome.inputTokens ?? null,
      outcome.outputTokens ?? null,
      outcome.reasoningTokens ?? null,
      outcome.cachedInputTokens ?? null,
      outcome.totalTokens ?? null,
      outcome.gatewayGenerationId ?? null,
      outcome.costUsd ?? null,
      JSON.stringify(outcome.providerMetadata ?? {}),
    ],
  );
}

