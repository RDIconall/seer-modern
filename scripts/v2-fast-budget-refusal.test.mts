/**
 * Spec for the fast-budget refusal.
 *
 * Once a mailbox has used its daily fast-call ceiling, later inbound mail must
 * stay unclassified. The refusal must not be treated as a fast-model outage:
 * that path is the only reason the strong model runs without an escalation.
 * These assertions fail while that fall-through is present.
 *
 * The model transport is the router's `call` seam. Production wires that seam
 * to `callGatewayModel`. The budget seam is not injected here, so the default
 * `withinDailyBudget` query runs against the test database.
 */
import assert from "node:assert/strict";
import { startTestDb } from "./v2-testdb.mts";
import { upsertAccount, upsertUser } from "../src/lib/v2/db/accounts.ts";
import { asConversationId, type AccountId } from "../src/lib/v2/db/types.ts";
import { conversationsNeedingRead } from "../src/lib/v2/intelligence/queue.ts";
import { loadConversation } from "../src/lib/v2/intelligence/load-conversation.ts";
import { readBatch } from "../src/lib/v2/intelligence/read-batch.ts";
import {
  createReaderRouter,
  type ModelCaller,
  type RoutedTier,
} from "../src/lib/v2/intelligence/model.ts";
import {
  recordModelUsage,
  withinDailyBudget,
  withinDailyCallLimit,
} from "../src/lib/v2/intelligence/model-usage.ts";
import type { ReaderModelInput } from "../src/lib/v2/intelligence/reader.ts";
import type { ReadResult } from "../src/lib/v2/intelligence/schema.ts";
import { runShadow } from "../src/lib/v2/shadow/run.ts";
import { FakeProvider } from "../src/lib/v2/providers/fake.ts";
import { syncFolder } from "../src/lib/v2/sync/engine.ts";
import type { Pool } from "pg";

const FAST_MODEL = "google/gemini-3.1-flash-lite";
const STRONG_MODEL = "anthropic/claude-sonnet-4.6";

const quiet: ReadResult = {
  home: "delete",
  summary: "Automated digest",
  rationale: "no business relevance",
  owner: "nobody",
  ask: "nothing — informational",
  obligation: false,
  yields: [],
  evidence: [],
};

type ObservedCall = {
  tier: RoutedTier;
  model: string;
  providerConversationId: string;
};

const failures: string[] = [];

async function check(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
    console.log(`PASS ${name}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    failures.push(`${name}: ${message}`);
    console.error(`FAIL ${name}: ${message}`);
  }
}

async function withEnv(
  values: Record<string, string | undefined>,
  fn: () => Promise<void>,
): Promise<void> {
  const previous = new Map<string, string | undefined>();
  for (const key of Object.keys(values)) {
    previous.set(key, process.env[key]);
    const value = values[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    await fn();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function recordingCaller(calls: ObservedCall[], failFast = false): ModelCaller {
  return async (model, tier, input) => {
    calls.push({
      tier,
      model,
      providerConversationId: input.conversation.providerConversationId,
    });
    if (failFast && tier === "fast") throw new Error("gateway timeout");
    return {
      output: quiet,
      usage: { inputTokens: 11, outputTokens: 7, totalTokens: 18 },
      latencyMs: 4,
    };
  };
}

/** Production router: real daily budget, real usage insert, stubbed transport. */
function productionRouter(call: ModelCaller) {
  return createReaderRouter({
    call,
    recordUsage: recordModelUsage,
  });
}

function attackerMessage(id: string, sentAt: string, mailbox: string) {
  return {
    providerMessageId: `${id}-m`,
    from: { email: "attacker@outside.test", name: "Outside" },
    to: [{ email: mailbox }],
    cc: [] as { email: string }[],
    sentAt,
    snippet: "Automated digest",
    bodyHtml: null,
    bodyText: "Automated digest. No action required.",
    isUnread: true,
    isOutgoing: false,
    attachments: [] as [],
    folder: "inbox" as const,
  };
}

async function syncAttackerMail(
  accountId: AccountId,
  mailbox: string,
  messages: { id: string; sentAt: string }[],
): Promise<void> {
  const provider = new FakeProvider({
    pageSize: 50,
    conversations: messages.map((message) => ({
      providerConversationId: message.id,
      subject: `Digest ${message.id}`,
      messages: [attackerMessage(message.id, message.sentAt, mailbox)],
    })),
  });
  const run = await syncFolder(accountId, provider, "inbox", "full");
  assert.ok(run.pages >= 1, "attacker mail must sync into the inbox");
  const queued = await conversationsNeedingRead(accountId, 20);
  assert.equal(
    queued.length,
    messages.length,
    "synced attacker mail must be waiting for the reader",
  );
}

async function seedFastUsage(
  pool: Pool,
  accountId: AccountId,
  count: number,
  costUsd?: number,
): Promise<void> {
  await pool.query(
    `insert into seer.model_usage
       (account_id, tier, model, latency_ms, cost_usd)
     select $1, 'fast', $2, 1, $4
       from generate_series(1, $3::int)`,
    [accountId, FAST_MODEL, count, costUsd ?? null],
  );
}

async function strongUsage(
  pool: Pool,
  accountId: AccountId,
): Promise<{ model: string; reasons: string[] }[]> {
  const result = await pool.query<{ model: string; escalation_reasons: string[] }>(
    `select model, escalation_reasons
       from seer.model_usage
      where account_id = $1 and tier = 'strong'
      order by created_at`,
    [accountId],
  );
  return result.rows.map((row) => ({
    model: row.model,
    reasons: row.escalation_reasons,
  }));
}

async function currentDecisions(
  pool: Pool,
  accountId: AccountId,
): Promise<string[]> {
  const result = await pool.query<{ provider_conversation_id: string }>(
    `select c.provider_conversation_id
       from seer.conversation_decisions d
       join seer.conversations c on c.id = d.conversation_id
      where d.account_id = $1 and d.is_current
      order by c.provider_conversation_id`,
    [accountId],
  );
  return result.rows.map((row) => row.provider_conversation_id);
}

const database = await startTestDb();
try {
  const userId = await upsertUser("budget-refusal@example.com");

  async function openMailbox(email: string): Promise<AccountId> {
    return upsertAccount({
      userId,
      provider: "google",
      email,
    });
  }

  await check("fast-outage-still-uses-strong", async () => {
    await withEnv(
      {
        SEER_ROUTER_FAST_MODEL: undefined,
        SEER_ROUTER_STRONG_MODEL: undefined,
      },
      async () => {
    const calls: ObservedCall[] = [];
    const router = productionRouter(recordingCaller(calls, true));
    const accountId = await openMailbox("outage@example.com");
    await syncAttackerMail(accountId, "outage@example.com", [
      { id: "outage-1", sentAt: "2026-11-20T12:00:00Z" },
    ]);
    const report = await readBatch(
      accountId,
      "outage@example.com",
      router,
      { limit: 5, concurrency: 1 },
    );
    assert.deepEqual(
      calls.map((call) => `${call.tier}:${call.model}`),
      [`fast:${FAST_MODEL}`, `strong:${STRONG_MODEL}`],
      "a fast call that was allowed to run and then failed may fall back to strong",
    );
    assert.deepEqual(await strongUsage(database.pool, accountId), [
      { model: STRONG_MODEL, reasons: ["fast_failed"] },
    ]);
    assert.equal(report.decided, 1);
    assert.deepEqual(await currentDecisions(database.pool, accountId), ["outage-1"]);
      },
    );
  });

  await check("strong-ceiling-does-not-run-during-fast-outage", async () => {
    await withEnv({ SEER_STRONG_DAILY_CALL_LIMIT: "0" }, async () => {
      const calls: ObservedCall[] = [];
      const router = productionRouter(recordingCaller(calls, true));
      const accountId = await openMailbox("strong-capped@example.com");
      await syncAttackerMail(accountId, "strong-capped@example.com", [
        { id: "capped-1", sentAt: "2026-11-20T12:00:00Z" },
      ]);
      const report = await readBatch(
        accountId,
        "strong-capped@example.com",
        router,
        { limit: 5, concurrency: 1 },
      );
      assert.deepEqual(
        calls.map((call) => call.tier),
        ["fast"],
        "a refused strong budget must not send the outage fallback",
      );
      assert.deepEqual(await strongUsage(database.pool, accountId), []);
      assert.equal(report.decided, 0);
      assert.equal(report.failed, 1);
      assert.deepEqual(await currentDecisions(database.pool, accountId), []);
    });
  });

  await check("spend-cap-refusal-does-not-call-strong", async () => {
    await withEnv(
      {
        SEER_FAST_DAILY_CALL_LIMIT: undefined,
        SEER_STRONG_DAILY_CALL_LIMIT: undefined,
        SEER_DAILY_SPEND_LIMIT_USD: "0.50",
      },
      async () => {
        const calls: ObservedCall[] = [];
        const router = productionRouter(recordingCaller(calls));
        const accountId = await openMailbox("spend-capped@example.com");
        await seedFastUsage(database.pool, accountId, 1, 1.25);
        assert.equal(await withinDailyBudget(accountId, "fast"), false);
        assert.equal(await withinDailyBudget(accountId, "strong"), false);
        await syncAttackerMail(accountId, "spend-capped@example.com", [
          { id: "spend-1", sentAt: "2026-11-20T12:00:00Z" },
        ]);
        await readBatch(
          accountId,
          "spend-capped@example.com",
          router,
          { limit: 5, concurrency: 1 },
        ).catch(() => undefined);
        assert.deepEqual(calls, []);
        assert.deepEqual(await strongUsage(database.pool, accountId), []);
        assert.deepEqual(await currentDecisions(database.pool, accountId), []);
      },
    );
  });

  await check("fast-ceiling-blocks-overflow-strong-call", async () => {
    await withEnv(
      {
        SEER_FAST_DAILY_CALL_LIMIT: undefined,
        SEER_STRONG_DAILY_CALL_LIMIT: undefined,
        SEER_DAILY_SPEND_LIMIT_USD: undefined,
        SEER_ROUTER_FAST_MODEL: undefined,
        SEER_ROUTER_STRONG_MODEL: undefined,
      },
      async () => {
        const calls: ObservedCall[] = [];
        const router = productionRouter(recordingCaller(calls));
        const accountId = await openMailbox("ceiling@example.com");
        await seedFastUsage(database.pool, accountId, 1000);
        assert.equal(
          await withinDailyCallLimit(accountId, "fast"),
          false,
          "1000 fast rows reach the default fast ceiling",
        );
        assert.equal(await withinDailyCallLimit(accountId, "strong"), true);
        assert.equal(await withinDailyBudget(accountId, "fast"), false);
        assert.equal(await withinDailyBudget(accountId, "strong"), true);
        await syncAttackerMail(accountId, "ceiling@example.com", [
          { id: "ceiling-a", sentAt: "2026-11-20T12:00:00Z" },
          { id: "ceiling-b", sentAt: "2026-11-20T12:01:00Z" },
          { id: "ceiling-c", sentAt: "2026-11-20T12:02:00Z" },
        ]);
        await readBatch(
          accountId,
          "ceiling@example.com",
          router,
          { limit: 10, concurrency: 3 },
        ).catch(() => undefined);
        assert.deepEqual(
          calls,
          [],
          "mail after the default fast ceiling must not be sent to either model",
        );
        assert.deepEqual(await strongUsage(database.pool, accountId), []);
        assert.deepEqual(await currentDecisions(database.pool, accountId), []);
        assert.equal((await conversationsNeedingRead(accountId, 20)).length, 3);
      },
    );
  });

  await check("router-refusal-is-not-an-outage", async () => {
    await withEnv(
      {
        SEER_FAST_DAILY_CALL_LIMIT: undefined,
        SEER_STRONG_DAILY_CALL_LIMIT: undefined,
        SEER_DAILY_SPEND_LIMIT_USD: undefined,
        SEER_ROUTER_FAST_MODEL: undefined,
        SEER_ROUTER_STRONG_MODEL: undefined,
      },
      async () => {
        const calls: ObservedCall[] = [];
        const router = productionRouter(recordingCaller(calls));
        const accountId = await openMailbox("router-direct@example.com");
        await seedFastUsage(database.pool, accountId, 1000);
        await syncAttackerMail(accountId, "router-direct@example.com", [
          { id: "direct-1", sentAt: "2026-11-20T15:00:00Z" },
        ]);
        const [conversationId] = await conversationsNeedingRead(accountId, 5);
        const conversation = await loadConversation(conversationId);
        assert.ok(conversation, "synced mail must load for the router");
        const input: ReaderModelInput = {
          accountId,
          conversationId: asConversationId(conversationId),
          conversation,
          contextText: "no prior relationship on record",
          routingFacts: {
            senderIsKnown: false,
            senderIsInternal: false,
            liveMatterId: null,
            addressedDirectly: true,
          },
        };
        let rejected = false;
        try {
          await router(input);
        } catch {
          rejected = true;
        }
        assert.deepEqual(
          calls,
          [],
          "the router itself must stop when the fast budget check returns false",
        );
        assert.equal(
          rejected,
          true,
          "a fast-budget refusal must not return a classification",
        );
        assert.deepEqual(await strongUsage(database.pool, accountId), []);
        assert.deepEqual(await currentDecisions(database.pool, accountId), []);
      },
    );
  });

  await check("same-tick-overflow-stays-on-the-queue", async () => {
    await withEnv(
      {
        SEER_FAST_DAILY_CALL_LIMIT: "1",
        SEER_ROUTER_FAST_MODEL: undefined,
        SEER_ROUTER_STRONG_MODEL: undefined,
      },
      async () => {
      const calls: ObservedCall[] = [];
      const router = productionRouter(recordingCaller(calls));
      const accountId = await openMailbox("same-tick@example.com");
      await syncAttackerMail(accountId, "same-tick@example.com", [
        { id: "older", sentAt: "2026-11-20T08:00:00Z" },
        { id: "newer", sentAt: "2026-11-20T09:00:00Z" },
      ]);
      await readBatch(
        accountId,
        "same-tick@example.com",
        router,
        { limit: 10, concurrency: 1 },
      ).catch(() => undefined);
      assert.deepEqual(
        calls.map((call) => `${call.providerConversationId}:${call.tier}:${call.model}`),
        [`newer:fast:${FAST_MODEL}`],
        "only the call allowed under the fast ceiling may run; the next mail stays unread",
      );
      assert.deepEqual(await strongUsage(database.pool, accountId), []);
      assert.deepEqual(await currentDecisions(database.pool, accountId), ["newer"]);
      const pending = await conversationsNeedingRead(accountId, 20);
      const pendingIds = await database.pool.query<{ provider_conversation_id: string }>(
        `select provider_conversation_id from seer.conversations where id = any($1::uuid[])`,
        [pending],
      );
      assert.deepEqual(
        pendingIds.rows.map((row) => row.provider_conversation_id),
        ["older"],
      );
    });
  });

  await check("budget-recheck-cannot-authorize-the-call", async () => {
    await withEnv(
      {
        SEER_FAST_DAILY_CALL_LIMIT: "1",
        SEER_STRONG_DAILY_CALL_LIMIT: undefined,
        SEER_DAILY_SPEND_LIMIT_USD: undefined,
      },
      async () => {
        const calls: ObservedCall[] = [];
        const accountId = await openMailbox("recheck@example.com");
        await seedFastUsage(database.pool, accountId, 1);
        await syncAttackerMail(accountId, "recheck@example.com", [
          { id: "recheck-1", sentAt: "2026-11-20T16:00:00Z" },
        ]);
        let fastChecks = 0;
        const router = createReaderRouter({
          call: recordingCaller(calls),
          recordUsage: recordModelUsage,
          allowCall: async (id, tier) => {
            const allowed = await withinDailyBudget(id, tier);
            if (tier === "fast") {
              fastChecks += 1;
              if (fastChecks === 1 && !allowed) {
                // The refusal was observed. A later lookup of the same budget
                // now says the ceiling is free. The call must still not run.
                await database.pool.query(
                  `delete from seer.model_usage
                    where account_id = $1 and tier = 'fast'`,
                  [accountId],
                );
              }
            }
            return allowed;
          },
        });
        await readBatch(accountId, "recheck@example.com", router, {
          limit: 5,
          concurrency: 1,
        }).catch(() => undefined);
        assert.deepEqual(
          calls,
          [],
          "a later budget lookup must not authorize a call the first refusal denied",
        );
        assert.deepEqual(await strongUsage(database.pool, accountId), []);
        assert.deepEqual(await currentDecisions(database.pool, accountId), []);
      },
    );
  });

  await check("another-mailbox-is-not-denied", async () => {
    await withEnv({ SEER_FAST_DAILY_CALL_LIMIT: "1" }, async () => {
      const calls: ObservedCall[] = [];
      const router = productionRouter(recordingCaller(calls));
      const quietId = await openMailbox("quiet-desk@example.com");
      const floodedId = await openMailbox("flooded-desk@example.com");
      await seedFastUsage(database.pool, floodedId, 1);
      await syncAttackerMail(quietId, "quiet-desk@example.com", [
        { id: "quiet-mail", sentAt: "2026-11-20T17:00:00Z" },
      ]);
      await syncAttackerMail(floodedId, "flooded-desk@example.com", [
        { id: "flood-mail", sentAt: "2026-11-20T17:00:00Z" },
      ]);
      await readBatch(quietId, "quiet-desk@example.com", router, {
        limit: 5,
        concurrency: 1,
      });
      await readBatch(floodedId, "flooded-desk@example.com", router, {
        limit: 5,
        concurrency: 1,
      });
      assert.deepEqual(
        calls.map((call) => `${call.providerConversationId}:${call.tier}`),
        ["quiet-mail:fast"],
        "one mailbox's fast ceiling does not authorize or deny another mailbox",
      );
      assert.deepEqual(await strongUsage(database.pool, floodedId), []);
      assert.deepEqual(await currentDecisions(database.pool, floodedId), []);
      assert.deepEqual(await currentDecisions(database.pool, quietId), ["quiet-mail"]);
    });
  });

  await check("shadow-read-does-not-spend-strong-on-overflow", async () => {
    await withEnv({ SEER_FAST_DAILY_CALL_LIMIT: "1" }, async () => {
      const calls: ObservedCall[] = [];
      const router = productionRouter(recordingCaller(calls));
      const accountId = await openMailbox("shadow@example.com");
      await seedFastUsage(database.pool, accountId, 1);
      await syncAttackerMail(accountId, "shadow@example.com", [
        { id: "shadow-1", sentAt: "2026-11-20T18:00:00Z" },
      ]);
      await runShadow({
        accountId,
        account: "shadow@example.com",
        model: router,
        context: {
          ownDomain: "example.com",
          ownEmail: "shadow@example.com",
          people: [],
          matters: [],
          interests: [],
        },
        benchmark: null,
        providerParityPassed: true,
      }).catch(() => undefined);
      assert.deepEqual(
        calls,
        [],
        "shadow classification uses the same router and must not spend the strong model",
      );
      assert.deepEqual(await strongUsage(database.pool, accountId), []);
      assert.deepEqual(await currentDecisions(database.pool, accountId), []);
    });
  });
} finally {
  await database.stop();
}

if (failures.length > 0) {
  throw new Error(failures.join("\n"));
}

console.log("v2-fast-budget-refusal: OK");
