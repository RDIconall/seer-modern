/**
 * Gate: deterministic fast→strong routing, no paid calls.
 *
 * Easy disposable mail stays on the cheap model. Consequential deletes,
 * matter creation/connections, live-matter continuations, and fast-model
 * failures escalate. If the strong daily cap is reached, consequential mail
 * becomes undecided rather than trusting the cheap call.
 */
import assert from "node:assert/strict";
import {
  createReaderRouter,
  escalationReasons,
  type ModelCallResult,
  type ModelCaller,
  type RoutedTier,
} from "../src/lib/v2/intelligence/model.ts";
import {
  asAccountId,
  asConversationId,
} from "../src/lib/v2/db/types.ts";
import type {
  ReaderModelInput,
} from "../src/lib/v2/intelligence/reader.ts";
import type {
  ReadResult,
} from "../src/lib/v2/intelligence/schema.ts";
import type {
  ModelUsageRecord,
} from "../src/lib/v2/intelligence/model-usage.ts";

const baseRead: ReadResult = {
  home: "delete",
  summary: "newsletter",
  rationale: "no business relevance",
  owner: "nobody",
  ask: "nothing — informational",
  obligation: false,
  yields: [],
  evidence: [],
};

const input: ReaderModelInput = {
  accountId: asAccountId("00000000-0000-0000-0000-000000000001"),
  conversationId: asConversationId(
    "00000000-0000-0000-0000-000000000002",
  ),
  contextText: "no prior relationship on record",
  conversation: {
    providerConversationId: "p1",
    subject: "Newsletter",
    lastMessageAt: "2026-08-10T00:00:00Z",
    messages: [
      {
        providerMessageId: "m1",
        from: { email: "news@example.com" },
        to: [{ email: "user@example.com" }],
        cc: [],
        sentAt: "2026-08-10T00:00:00Z",
        snippet: "news",
        bodyHtml: null,
        bodyText: "Generic newsletter",
        isUnread: true,
        isOutgoing: false,
        attachments: [],
      },
    ],
  },
  routingFacts: {
    senderIsKnown: false,
    senderIsInternal: false,
    liveMatterId: null,
    addressedDirectly: false,
  },
};

function result(output: ReadResult): ModelCallResult {
  return {
    output,
    usage: {
      inputTokens: 100,
      outputTokens: 20,
      reasoningTokens: 5,
      cachedInputTokens: 10,
      totalTokens: 125,
    },
    providerMetadata: {
      gateway: { generationId: "gen_test", cost: "0.0012" },
    },
    latencyMs: 25,
  };
}

function harness(outputs: Partial<Record<RoutedTier, ReadResult>>) {
  const calls: RoutedTier[] = [];
  const usage: ModelUsageRecord[] = [];
  const call: ModelCaller = async (_model, tier) => {
    calls.push(tier);
    const output = outputs[tier];
    if (!output) throw new Error(`${tier} failed`);
    return result(output);
  };
  const router = createReaderRouter({
    call,
    recordUsage: async (record) => {
      usage.push(record);
    },
    allowCall: async () => true,
  });
  return { router, calls, usage };
}

// Easy, unprotected delete: fast only.
{
  const h = harness({ fast: baseRead });
  const output = await h.router(input);
  assert.equal(output.home, "delete");
  assert.deepEqual(h.calls, ["fast"]);
  assert.equal(h.usage.length, 1);
  assert.equal(h.usage[0].gatewayGenerationId, "gen_test");
  assert.equal(h.usage[0].costUsd, 0.0012);
}

// Delete of a known sender: strong review.
{
  const h = harness({
    fast: baseRead,
    strong: { ...baseRead, home: "record", rationale: "known relationship" },
  });
  const output = await h.router({
    ...input,
    routingFacts: { ...input.routingFacts, senderIsKnown: true },
  });
  assert.equal(output.home, "record");
  assert.deepEqual(h.calls, ["fast", "strong"]);
  assert.deepEqual(h.usage[1].escalationReasons, ["delete_known_sender"]);
}

// Being in To alone is NOT a direct-message signal: mass mail commonly puts
// the user in To. Without an ask/owner/relationship, it stays on fast.
{
  const h = harness({ fast: baseRead });
  const output = await h.router({
    ...input,
    routingFacts: { ...input.routingFacts, addressedDirectly: true },
  });
  assert.equal(output.home, "delete");
  assert.deepEqual(h.calls, ["fast"]);
}

// A matter proposal and a matter_connection are both structural → strong.
{
  const fast: ReadResult = {
    ...baseRead,
    home: "matter",
    yields: [
      {
        kind: "matter_connection",
        matterRef: "Roche anti-TPO",
        headline: "New pricing",
      },
    ],
  };
  const reasons = escalationReasons(fast, input);
  assert.ok(reasons.includes("proposed_matter"));
  assert.ok(reasons.includes("matter_connection"));

  const h = harness({ fast, strong: { ...fast, home: "matter" } });
  await h.router(input);
  assert.deepEqual(h.calls, ["fast", "strong"]);
}

// A continuation of a live matter escalates regardless of the fast home.
{
  const h = harness({
    fast: { ...baseRead, home: "record" },
    strong: { ...baseRead, home: "matter" },
  });
  const output = await h.router({
    ...input,
    routingFacts: { ...input.routingFacts, liveMatterId: "matter-1" },
  });
  assert.equal(output.home, "matter");
  assert.ok(h.usage[1].escalationReasons.includes("live_matter"));
}

// Fast outage fails over to strong (different provider/model path).
{
  const h = harness({
    strong: { ...baseRead, home: "record", rationale: "strong fallback" },
  });
  const output = await h.router(input);
  assert.equal(output.home, "record");
  assert.deepEqual(h.calls, ["fast", "strong"]);
  assert.deepEqual(h.usage[0].escalationReasons, ["fast_failed"]);
}

// Strong cap reached: don't trust consequential fast result; hold undecided.
{
  const calls: RoutedTier[] = [];
  const router = createReaderRouter({
    call: async (_model, tier) => {
      calls.push(tier);
      return result(baseRead);
    },
    recordUsage: async () => {},
    allowCall: async (_accountId, tier) => tier === "fast",
  });
  const output = await router({
    ...input,
    routingFacts: { ...input.routingFacts, senderIsKnown: true },
  });
  assert.equal(output.home, "undecided");
  assert.match(output.rationale, /daily limit/i);
  assert.deepEqual(calls, ["fast"]);
}

console.log("v2-model-router: OK");

