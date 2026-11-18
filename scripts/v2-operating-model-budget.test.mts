/**
 * Atlas section proposal must not spend the strong model without a per-account
 * daily budget.
 *
 * These assertions fail while POST /api/v2/operating-model action=propose (and
 * proposeOperatingModel, which that route calls) still invokes the strong model
 * with no withinDailyBudget check, an uncapped note, and a usage row that omits
 * tokens and cost. They pass once that path refuses over-budget calls before
 * the gateway request, caps the note, records the gateway usage, and does not
 * let a second in-flight propose pass the same check.
 *
 * The gateway HTTP call is the real AI SDK generateText path (ai@7.0.31). The
 * stand-in answers only https://ai-gateway.vercel.sh/v4/ai/language-model with
 * the LanguageModelV4 doGenerate shape that GatewayLanguageModel.doGenerate
 * spreads into generateText. No request leaves the machine.
 */
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mock } from "node:test";
import type { AccountId } from "../src/lib/v2/db/types.ts";
import type { MailProvider } from "../src/lib/v2/providers/types.ts";

process.env.SEER_DATA_DIR = path.join(os.tmpdir(), "seer-operating-model-budget");
// Obvious placeholder so the SDK takes the API-key branch of getGatewayAuthToken
// and reaches postJsonToApi. The fetch stand-in never sends it.
process.env.AI_GATEWAY_API_KEY = "placeholder-not-a-secret";
delete process.env.SEER_ROUTER_STRONG_MODEL;
delete process.env.SEER_ROUTER_FAST_MODEL;

const session: { email: string | null; activeAccountId: string | null } = {
  email: null,
  activeAccountId: null,
};

mock.module("@/auth", {
  namedExports: {
    auth: async () => ({
      user: { email: session.email },
      activeAccountId: session.activeAccountId,
    }),
  },
});

mock.module("next/headers", {
  namedExports: {
    cookies: async () => ({
      get: () => undefined,
      getAll: () => [],
      set() {},
      delete() {},
    }),
    headers: async () => new Headers(),
  },
});

const GATEWAY_URL = "https://ai-gateway.vercel.sh/v4/ai/language-model";
const STRONG_MODEL = "anthropic/claude-sonnet-4.6";
/** Spec: the note copied into the model prompt is a few thousand characters. */
const NOTE_MIN = 2000;
const NOTE_MAX = 4000;
const INPUT_TOKENS = 1111;
const OUTPUT_TOKENS = 222;
const COST_USD = 0.05;

const PROPOSAL = {
  functions: [{ name: "house", why: "repairs and quotes" }],
  topics: [{ name: "receipts", why: "trashed promos" }],
  guidance: "House projects are matters. Promo mail is a topic.",
  rationale: "Sent a paint quote and trashed a sale.",
};

type GatewayCall = {
  model: string | null;
  promptText: string;
  note: string | undefined;
};

const calls: GatewayCall[] = [];
let hold: Promise<void> | null = null;

function gatewayResponse(): Response {
  return new Response(
    JSON.stringify({
      content: [{ type: "text", text: JSON.stringify(PROPOSAL) }],
      finishReason: { unified: "stop", raw: "stop" },
      usage: {
        inputTokens: {
          total: INPUT_TOKENS,
          noCache: INPUT_TOKENS,
          cacheRead: 0,
          cacheWrite: 0,
        },
        outputTokens: {
          total: OUTPUT_TOKENS,
          text: OUTPUT_TOKENS,
          reasoning: 0,
        },
      },
      providerMetadata: {
        gateway: { cost: COST_USD, generationId: "gen_operating_model" },
      },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

function installGatewayStandIn(): void {
  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;
    if (url !== GATEWAY_URL) {
      // Refuse every other host. Do not fall through to the real network.
      throw new Error(`blocked unexpected fetch host ${new URL(url).host}`);
    }
    const raw = typeof init?.body === "string" ? init.body : "";
    const parsed = JSON.parse(raw) as {
      prompt?: { content?: { text?: string }[] }[];
    };
    let promptText = "";
    let note: string | undefined;
    const texts: string[] = [];
    const walk = (value: unknown) => {
      if (typeof value === "string") texts.push(value);
      else if (Array.isArray(value)) value.forEach(walk);
      else if (value && typeof value === "object") {
        Object.values(value).forEach(walk);
      }
    };
    walk(parsed);
    for (const text of texts) {
      if (!text.includes('"mail"')) continue;
      try {
        const inner = JSON.parse(text) as { note?: unknown; mail?: unknown };
        if (!Array.isArray(inner.mail)) continue;
        promptText = text;
        note = typeof inner.note === "string" ? inner.note : undefined;
        break;
      } catch {
        /* system text is not the corpus payload */
      }
    }
    const headers = new Headers(init?.headers);
    calls.push({
      model: headers.get("ai-language-model-id"),
      promptText,
      note,
    });
    if (hold) await hold;
    return gatewayResponse();
  };
}

function signIn(email: string | null, accountId: string | null = null): void {
  session.email = email;
  session.activeAccountId = accountId;
}

function postPropose(note?: string): Promise<Response> {
  return POST(
    new Request("http://127.0.0.1:3000/api/v2/operating-model", {
      method: "POST",
      headers: {
        origin: "http://127.0.0.1:3000",
        "content-type": "application/json",
      },
      body: JSON.stringify({ action: "propose", note }),
    }),
  );
}

function budgetMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const { startTestDb } = await import("./v2-testdb.mts");
const { upsertUser, upsertAccount } = await import(
  "../src/lib/v2/db/accounts.ts"
);
const { recordModelUsage } = await import(
  "../src/lib/v2/intelligence/model-usage.ts"
);
const { proposeOperatingModel } = await import(
  "../src/lib/v2/intelligence/operating-model.ts"
);
const { POST } = await import(
  "../src/app/api/v2/operating-model/route.ts"
);

installGatewayStandIn();

const db = await startTestDb();
const limits = {
  strong: process.env.SEER_STRONG_DAILY_CALL_LIMIT,
  fast: process.env.SEER_FAST_DAILY_CALL_LIMIT,
  spend: process.env.SEER_DAILY_SPEND_LIMIT_USD,
};

try {
  async function mailbox(local: string) {
    const email = `${local}@rditrials.com`;
    const userId = await upsertUser(email);
    const accountId = await upsertAccount({
      userId,
      provider: "google",
      email,
    });
    return { email, accountId };
  }

  async function insertConversation(
    accountId: AccountId,
    providerConversationId: string,
    subject: string,
  ) {
    await db.pool.query(
      `insert into seer.conversations
         (account_id, provider_conversation_id, subject, folders, is_deleted, last_message_at)
       values ($1, $2, $3, array['inbox'], false, now())`,
      [accountId, providerConversationId, subject],
    );
    const conv = await db.pool.query<{ id: string }>(
      `select id from seer.conversations
        where account_id = $1 and provider_conversation_id = $2`,
      [accountId, providerConversationId],
    );
    await db.pool.query(
      `insert into seer.messages
         (account_id, conversation_id, provider_message_id, from_email, snippet, body_text)
       values ($1, $2, $3, 'painter@example.com', 'Kitchen paint next week', 'Kitchen paint next week')`,
      [accountId, conv.rows[0].id, `${providerConversationId}-m`],
    );
  }

  async function usageCount(accountId: AccountId): Promise<number> {
    const result = await db.pool.query<{ n: number }>(
      `select count(*)::int as n from seer.model_usage where account_id = $1`,
      [accountId],
    );
    return result.rows[0]?.n ?? 0;
  }

  async function proposalCount(accountId: AccountId): Promise<number> {
    const result = await db.pool.query<{ n: number }>(
      `select count(*)::int as n from seer.operating_models where account_id = $1`,
      [accountId],
    );
    return result.rows[0]?.n ?? 0;
  }

  process.env.SEER_STRONG_DAILY_CALL_LIMIT = "1";
  process.env.SEER_FAST_DAILY_CALL_LIMIT = "1000";
  process.env.SEER_DAILY_SPEND_LIMIT_USD = "0";
  const failures: string[] = [];
  async function section(name: string, run: () => Promise<void>) {
    try {
      await run();
      console.log("PASS", name);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      failures.push(`${name}: ${message}`);
      console.log("FAIL", name, message.split("\n")[0]);
    }
  }

  const gate = await mailbox("budget-gate");

  // Unsigned and cross-origin requests never reach the model. An unknown
  // action is refused for a signed-in mailbox before any completion.
  await section("gates", async () => {
    const before = calls.length;
    signIn(null);
    const unsigned = await postPropose("hello");
    assert.equal(unsigned.status, 404);
    const foreign = await POST(
      new Request("http://127.0.0.1:3000/api/v2/operating-model", {
        method: "POST",
        headers: {
          origin: "https://evil.example",
          "content-type": "application/json",
        },
        body: JSON.stringify({ action: "propose", note: "hello" }),
      }),
    );
    assert.equal(foreign.status, 403);
    signIn(gate.email, gate.accountId);
    const unknown = await POST(
      new Request("http://127.0.0.1:3000/api/v2/operating-model", {
        method: "POST",
        headers: {
          origin: "http://127.0.0.1:3000",
          "content-type": "application/json",
        },
        body: JSON.stringify({ action: "apply" }),
      }),
    );
    assert.equal(unknown.status, 400);
    assert.equal(calls.length, before);
  });

  // A signed-in mailbox already at the strong call ceiling cannot start
  // another paid completion. Fast-tier rows do not consume that ceiling.
  // Another mailbox under the ceiling still can.
  await section("call ceiling", async () => {
    const blocked = await mailbox("budget-blocked");
    await insertConversation(blocked.accountId, "blocked-inbox", "BLOCKED_SUBJECT");
    await recordModelUsage({
      accountId: blocked.accountId,
      tier: "strong",
      model: STRONG_MODEL,
      escalationReasons: ["operating_model"],
      latencyMs: 10,
      inputTokens: 1,
      outputTokens: 1,
      costUsd: 0.001,
    });

    const blockedBefore = calls.length;
    const blockedUsage = await usageCount(blocked.accountId);
    signIn(blocked.email, blocked.accountId);
    const denied = await postPropose("please propose");
    assert.notEqual(denied.status, 200);
    const deniedBody = (await denied.json()) as { error?: string };
    assert.match(deniedBody.error ?? "", /budget|limit|ceiling|cap/i);
    assert.equal(calls.length, blockedBefore, "over-budget propose must not call the model");
    assert.equal(await usageCount(blocked.accountId), blockedUsage);
    assert.equal(await proposalCount(blocked.accountId), 0);

    await assert.rejects(
      () =>
        proposeOperatingModel(blocked.accountId, blocked.email, {
          note: "direct",
        }),
      (error: unknown) => {
        assert.match(budgetMessage(error), /budget|limit|ceiling|cap/i);
        return true;
      },
    );
    assert.equal(calls.length, blockedBefore);
  });

  await section("under ceiling", async () => {
    const allowed = await mailbox("budget-allowed");
    await insertConversation(allowed.accountId, "allowed-inbox", "ALLOWED_SUBJECT");
    for (let i = 0; i < 5; i++) {
      await recordModelUsage({
        accountId: allowed.accountId,
        tier: "fast",
        model: "google/gemini-3.1-flash-lite",
        escalationReasons: ["filing"],
        latencyMs: 1,
        inputTokens: 10,
        outputTokens: 2,
        costUsd: 0.0001,
      });
    }
    const before = calls.length;
    signIn(allowed.email, allowed.accountId);
    const ok = await postPropose("short note");
    assert.equal(ok.status, 200, await ok.clone().text());
    const made = calls.slice(before);
    assert.equal(made.length, 1);
    assert.equal(made[0].model, STRONG_MODEL);
    assert.match(made[0].promptText, /ALLOWED_SUBJECT/);
    assert.doesNotMatch(made[0].promptText, /BLOCKED_SUBJECT/);
  });

  // A completed propose has to persist the gateway's input tokens, output
  // tokens, and dollar cost on this mailbox's usage row.
  await section("usage row", async () => {
    process.env.SEER_STRONG_DAILY_CALL_LIMIT = "50";
    process.env.SEER_DAILY_SPEND_LIMIT_USD = String(COST_USD);
    const spent = await mailbox("budget-spend");
    const other = await mailbox("budget-other-mail");
    await insertConversation(spent.accountId, "spend-inbox", "SPEND_SUBJECT");
    await insertConversation(other.accountId, "other-inbox", "OTHER_SUBJECT");
    const before = calls.length;
    signIn(spent.email, spent.accountId);
    const first = await postPropose("short note");
    assert.equal(first.status, 200, await first.clone().text());
    const made = calls.slice(before);
    assert.equal(made.length, 1);
    assert.equal(made[0].model, STRONG_MODEL);
    assert.match(made[0].promptText, /SPEND_SUBJECT/);
    assert.doesNotMatch(made[0].promptText, /OTHER_SUBJECT/);
    const row = await db.pool.query<{
      tier: string;
      model: string;
      input_tokens: number | null;
      output_tokens: number | null;
      cost_usd: string | null;
      escalation_reasons: string[];
    }>(
      `select tier, model, input_tokens, output_tokens, cost_usd, escalation_reasons
         from seer.model_usage
        where account_id = $1 and tier = 'strong'`,
      [spent.accountId],
    );
    assert.equal(row.rowCount, 1);
    assert.equal(row.rows[0].tier, "strong");
    assert.equal(row.rows[0].model, STRONG_MODEL);
    assert.ok(row.rows[0].escalation_reasons.includes("operating_model"));
    assert.equal(row.rows[0].input_tokens, INPUT_TOKENS);
    assert.equal(row.rows[0].output_tokens, OUTPUT_TOKENS);
    assert.equal(Number(row.rows[0].cost_usd), COST_USD);
  });

  await section("note cap", async () => {
    process.env.SEER_STRONG_DAILY_CALL_LIMIT = "50";
    process.env.SEER_DAILY_SPEND_LIMIT_USD = "0";
    const noted = await mailbox("budget-note");
    const note = `atlas-note:${"N".repeat(20_000)}`;
    signIn(noted.email, noted.accountId);
    const before = calls.length;
    const response = await postPropose(note);
    assert.equal(response.status, 200, await response.clone().text());
    const made = calls.slice(before);
    assert.equal(made.length, 1);
    assert.equal(typeof made[0].note, "string");
    const kept = made[0].note ?? "";
    assert.ok(
      kept.length >= NOTE_MIN && kept.length <= NOTE_MAX,
      `note in the model prompt must be ${NOTE_MIN}-${NOTE_MAX} characters, was ${kept.length}`,
    );
    assert.equal(kept, note.slice(0, kept.length));
    assert.ok(!made[0].promptText.includes(note.slice(0, NOTE_MAX + 1)));
  });

  await section("repeat after cost", async () => {
    process.env.SEER_STRONG_DAILY_CALL_LIMIT = "50";
    process.env.SEER_DAILY_SPEND_LIMIT_USD = String(COST_USD);
    const spent = await mailbox("budget-repeat");
    signIn(spent.email, spent.accountId);
    const before = calls.length;
    const first = await postPropose("first");
    assert.equal(first.status, 200, await first.clone().text());
    assert.equal(calls.length, before + 1);
    const second = await postPropose("second");
    assert.notEqual(second.status, 200);
    const body = (await second.json()) as { error?: string };
    assert.match(body.error ?? "", /budget|limit|ceiling|cap/i);
    assert.equal(calls.length, before + 1);
  });

  // Configured strong model id is what the gateway is asked for, and a live
  // provider page is part of that same prompt.
  await section("live provider", async () => {
    process.env.SEER_DAILY_SPEND_LIMIT_USD = "100";
    process.env.SEER_STRONG_DAILY_CALL_LIMIT = "50";
    process.env.SEER_ROUTER_STRONG_MODEL = "test/configured-strong";
    const live = await mailbox("budget-live");
    await insertConversation(live.accountId, "live-stored", "STORED_SUBJECT");
    const provider = {
      kind: "google" as const,
      async syncFolder() {
        return {
          conversations: [
            {
              providerConversationId: "live-1",
              subject: "LIVE_FOLDER_SUBJECT",
              lastMessageAt: "2026-08-01T00:00:00.000Z",
              messages: [
                {
                  providerMessageId: "live-m",
                  from: { email: "live@example.com" },
                  to: [],
                  cc: [],
                  sentAt: "2026-08-01T00:00:00.000Z",
                  snippet: "live snippet",
                  bodyHtml: null,
                  bodyText: "live body",
                  isUnread: false,
                  isOutgoing: true,
                  attachments: [],
                },
              ],
            },
          ],
          deletedConversationIds: [],
          nextCursor: null,
          providerTotal: 1,
        };
      },
      async search() {
        return { conversations: [], nextCursor: null };
      },
    };
    const before = calls.length;
    const { corpus } = await proposeOperatingModel(live.accountId, live.email, {
      provider: provider as MailProvider,
      note: "from this mailbox",
    });
    delete process.env.SEER_ROUTER_STRONG_MODEL;
    const made = calls.slice(before);
    assert.equal(made.length, 1);
    assert.equal(made[0].model, "test/configured-strong");
    assert.match(made[0].promptText, /LIVE_FOLDER_SUBJECT/);
    assert.match(made[0].promptText, /STORED_SUBJECT/);
    assert.ok((corpus.counts.sent ?? 0) + (corpus.counts.trash ?? 0) >= 1);
    const row = await db.pool.query<{ model: string; cost_usd: string | null }>(
      `select model, cost_usd from seer.model_usage
        where account_id = $1 and tier = 'strong'`,
      [live.accountId],
    );
    assert.equal(row.rows[0].model, "test/configured-strong");
    assert.equal(Number(row.rows[0].cost_usd), COST_USD);
  });

  // Two proposes in flight share one remaining call slot. Holding the gateway
  // response open keeps the first usage row unwritten; a check that runs again
  // before that row exists must still allow only one completion.
  await section("parallel", async () => {
    delete process.env.SEER_ROUTER_STRONG_MODEL;
    process.env.SEER_STRONG_DAILY_CALL_LIMIT = "1";
    process.env.SEER_DAILY_SPEND_LIMIT_USD = "0";
    const racer = await mailbox("budget-race");
    let release = () => {};
    hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    const before = calls.length;
    const pending = Promise.allSettled([
      proposeOperatingModel(racer.accountId, racer.email, { note: "one" }),
      proposeOperatingModel(racer.accountId, racer.email, { note: "two" }),
    ]);
    const deadline = Date.now() + 3000;
    while (calls.length - before < 2 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    const inFlight = calls.length - before;
    release();
    hold = null;
    const settled = await pending;
    assert.equal(
      inFlight,
      1,
      "parallel proposes must not all pass the budget check before a usage row is written",
    );
    assert.equal(calls.length - before, 1);
    const fulfilled = settled.filter((result) => result.status === "fulfilled");
    const rejected = settled.filter((result) => result.status === "rejected");
    assert.equal(fulfilled.length, 1);
    assert.equal(rejected.length, 1);
    assert.match(
      budgetMessage(
        (rejected[0] as PromiseRejectedResult).reason,
      ),
      /budget|limit|ceiling|cap/i,
    );
  });

  if (failures.length > 0) {
    throw new Error(`\n${failures.join("\n\n")}`);
  }
  console.log("v2-operating-model-budget: ok");
} finally {
  hold = null;
  if (limits.strong === undefined) delete process.env.SEER_STRONG_DAILY_CALL_LIMIT;
  else process.env.SEER_STRONG_DAILY_CALL_LIMIT = limits.strong;
  if (limits.fast === undefined) delete process.env.SEER_FAST_DAILY_CALL_LIMIT;
  else process.env.SEER_FAST_DAILY_CALL_LIMIT = limits.fast;
  if (limits.spend === undefined) delete process.env.SEER_DAILY_SPEND_LIMIT_USD;
  else process.env.SEER_DAILY_SPEND_LIMIT_USD = limits.spend;
  delete process.env.SEER_ROUTER_STRONG_MODEL;
  await db.stop();
}
