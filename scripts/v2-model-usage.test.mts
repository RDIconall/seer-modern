/** Gate: every model call is persisted and hard daily limits stop runaway use. */
import assert from "node:assert/strict";
import { startTestDb } from "./v2-testdb.mts";
import {
  upsertAccount,
  upsertUser,
} from "../src/lib/v2/db/accounts.ts";
import {
  recordModelUsage,
  withinDailyBudget,
  withinDailyCallLimit,
  withinDailySpendLimit,
} from "../src/lib/v2/intelligence/model-usage.ts";

const database = await startTestDb();
try {
  const userId = await upsertUser("usage@example.com");
  const accountId = await upsertAccount({
    userId,
    provider: "google",
    email: "usage@example.com",
  });

  await recordModelUsage({
    accountId,
    tier: "fast",
    model: "google/gemini-3.1-flash-lite",
    escalationReasons: [],
    latencyMs: 80,
    inputTokens: 100,
    outputTokens: 20,
    reasoningTokens: 5,
    cachedInputTokens: 10,
    totalTokens: 125,
    gatewayGenerationId: "gen_123",
    costUsd: 0.0012,
    providerMetadata: { gateway: { generationId: "gen_123" } },
  });

  const row = await database.pool.query(
    `select tier, model, input_tokens, reasoning_tokens,
            gateway_generation_id, cost_usd
       from seer.model_usage where account_id = $1`,
    [accountId],
  );
  assert.equal(row.rowCount, 1);
  assert.equal(row.rows[0].tier, "fast");
  assert.equal(row.rows[0].input_tokens, 100);
  assert.equal(row.rows[0].reasoning_tokens, 5);
  assert.equal(row.rows[0].gateway_generation_id, "gen_123");
  assert.equal(Number(row.rows[0].cost_usd), 0.0012);

  const oldFast = process.env.SEER_FAST_DAILY_CALL_LIMIT;
  const oldStrong = process.env.SEER_STRONG_DAILY_CALL_LIMIT;
  try {
    process.env.SEER_FAST_DAILY_CALL_LIMIT = "1";
    process.env.SEER_STRONG_DAILY_CALL_LIMIT = "1";
    assert.equal(
      await withinDailyCallLimit(accountId, "fast"),
      false,
      "one fast call exhausts a limit of one",
    );
    assert.equal(
      await withinDailyCallLimit(accountId, "strong"),
      true,
      "fast calls do not consume the strong budget",
    );
  } finally {
    if (oldFast === undefined) delete process.env.SEER_FAST_DAILY_CALL_LIMIT;
    else process.env.SEER_FAST_DAILY_CALL_LIMIT = oldFast;
    if (oldStrong === undefined) delete process.env.SEER_STRONG_DAILY_CALL_LIMIT;
    else process.env.SEER_STRONG_DAILY_CALL_LIMIT = oldStrong;
  }

  const oldSpend = process.env.SEER_DAILY_SPEND_LIMIT_USD;
  try {
    process.env.SEER_DAILY_SPEND_LIMIT_USD = "0.001";
    assert.equal(
      await withinDailySpendLimit(accountId),
      false,
      "recorded $0.0012 exceeds a $0.001 spend cap",
    );
    process.env.SEER_DAILY_SPEND_LIMIT_USD = "1";
    assert.equal(await withinDailySpendLimit(accountId), true);
    process.env.SEER_FAST_DAILY_CALL_LIMIT = "100";
    assert.equal(await withinDailyBudget(accountId, "fast"), true);
    process.env.SEER_DAILY_SPEND_LIMIT_USD = "0.001";
    assert.equal(
      await withinDailyBudget(accountId, "fast"),
      false,
      "spend cap fails the combined daily budget even when calls remain",
    );
  } finally {
    if (oldFast === undefined) delete process.env.SEER_FAST_DAILY_CALL_LIMIT;
    else process.env.SEER_FAST_DAILY_CALL_LIMIT = oldFast;
    if (oldSpend === undefined) delete process.env.SEER_DAILY_SPEND_LIMIT_USD;
    else process.env.SEER_DAILY_SPEND_LIMIT_USD = oldSpend;
  }

  console.log("v2-model-usage: OK");
} finally {
  await database.stop();
}

