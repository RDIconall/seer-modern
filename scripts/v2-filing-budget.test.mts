/**
 * Gate: filing and matter naming obey the same daily model budget as the reader.
 *
 * The reader stops calling the gateway once withinDailyBudget is false. Filing
 * a batch and naming a matter are paid gateway calls too. A wake from the
 * unauthenticated Gmail push endpoint, and a read tick from the cron route,
 * both run those calls after the reader. These tests drive those routes with
 * the real generateText → AI Gateway client and fail while either call is
 * still issued once the budget is already spent, or once a concurrent usage
 * row lands after an earlier look at the same budget.
 */
import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";
import { startTestDb } from "./v2-testdb.mts";

// Next's after() store is created when its module loads. Node keeps
// AsyncLocalStorage on node:async_hooks, and Next only uses it when it is
// already on globalThis, so this assignment has to precede that import.
(globalThis as { AsyncLocalStorage?: typeof AsyncLocalStorage }).AsyncLocalStorage =
  AsyncLocalStorage;
import {
  saveCredentials,
  upsertAccount,
  upsertUser,
} from "../src/lib/v2/db/accounts.ts";
import { asConversationId, type AccountId } from "../src/lib/v2/db/types.ts";
import { seedFunctions } from "../src/lib/v2/intelligence/functions.ts";
import {
  recordModelUsage,
  withinDailyBudget,
  withinDailyCallLimit,
} from "../src/lib/v2/intelligence/model-usage.ts";
import { saveDecision } from "../src/lib/v2/intelligence/repository.ts";

const { AfterContext } = await import("next/dist/server/after/after-context.js");
const { workAsyncStorage } = await import(
  "next/dist/server/app-render/work-async-storage.external.js"
);
const { POST: gmailPush } = await import("../src/app/api/webhooks/gmail/route.ts");
const { GET: readCron } = await import("../src/app/api/v2/read/route.ts");

const GATEWAY_PREFIX = "https://ai-gateway.vercel.sh/";
const GMAIL_PREFIX = "https://gmail.googleapis.com/";
const PLACEHOLDER = "placeholder";

process.env.AI_GATEWAY_API_KEY = PLACEHOLDER;
process.env.CRON_SECRET = PLACEHOLDER;
delete process.env.AUTH_URL;
delete process.env.VERCEL_URL;

type ModelCall = { url: string; kind: "filing" | "naming" | "reader" | "other" };

const modelCalls: ModelCall[] = [];
const originalFetch = globalThis.fetch.bind(globalThis);

function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.toString();
  return input.url;
}

function callKind(body: string): ModelCall["kind"] {
  if (body.includes("Name the active work board")) return "naming";
  if (body.includes("You file an executive")) return "filing";
  if (body.includes("chief of staff")) return "reader";
  return "other";
}

function gatewayResult(kind: ModelCall["kind"]): string {
  const text =
    kind === "naming"
      ? JSON.stringify({ matters: [] })
      : JSON.stringify({ filings: [] });
  return JSON.stringify({
    content: [{ type: "text", text }],
    finishReason: { unified: "stop", raw: "stop" },
    usage: {
      inputTokens: { total: 12, noCache: 12, cacheRead: 0, cacheWrite: 0 },
      outputTokens: { total: 8, text: 8, reasoning: 0 },
    },
    warnings: [],
  });
}

globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = requestUrl(input);
  if (url.startsWith(GMAIL_PREFIX)) {
    return new Response(
      JSON.stringify({ threads: [], resultSizeEstimate: 0 }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }
  const body = typeof init?.body === "string" ? init.body : "";
  if (url.startsWith(GATEWAY_PREFIX)) {
    const kind = callKind(body);
    modelCalls.push({ url, kind });
    return new Response(gatewayResult(kind), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }
  modelCalls.push({ url, kind: "other" });
  throw new Error(`unexpected outbound request to ${new URL(url).host}`);
}) as typeof fetch;

const database = await startTestDb();
database.pool.on("error", () => {
  // Stopping embedded Postgres drops idle clients. That is shutdown, not a failure.
});

let exhaustAccountId: AccountId | null = null;
const originalQuery = database.pool.query.bind(database.pool);
database.pool.query = ((...args: Parameters<typeof originalQuery>) => {
  const pending = originalQuery(...args);
  return Promise.resolve(pending).then(async (result) => {
    if (exhaustAccountId) {
      const sql = typeof args[0] === "string" ? args[0] : "";
      const listsUnfiledMatters =
        sql.includes("from seer.matters") && sql.includes("function_name is null");
      if (listsUnfiledMatters) {
        const accountId = exhaustAccountId;
        exhaustAccountId = null;
        await recordModelUsage({
          accountId,
          tier: "fast",
          model: "google/gemini-3.1-flash-lite",
          escalationReasons: ["concurrent-reader"],
          latencyMs: 1,
          inputTokens: 1,
          outputTokens: 1,
          totalTokens: 2,
          costUsd: 0,
        });
      }
    }
    return result;
  });
}) as typeof database.pool.query;

function setBudget(fast: string | undefined, spend: string | undefined) {
  if (fast === undefined) delete process.env.SEER_FAST_DAILY_CALL_LIMIT;
  else process.env.SEER_FAST_DAILY_CALL_LIMIT = fast;
  if (spend === undefined) delete process.env.SEER_DAILY_SPEND_LIMIT_USD;
  else process.env.SEER_DAILY_SPEND_LIMIT_USD = spend;
}

async function openMailbox(label: string): Promise<AccountId> {
  const email = `${label}@example.com`;
  const userId = await upsertUser(email);
  const accountId = await upsertAccount({
    userId,
    provider: "google",
    email,
  });
  await saveCredentials(accountId, "google", {
    accessToken: PLACEHOLDER,
    expiresAt: Date.now() + 7 * 24 * 60 * 60 * 1000,
  });
  await seedFunctions(accountId);
  return accountId;
}

async function addMatter(
  accountId: AccountId,
  title: string,
  fields: {
    functionName?: string | null;
    shortTitle?: string | null;
    shortTitleSource?: "inferred" | "user" | null;
    shortTitleVersion?: number | null;
  } = {},
): Promise<string> {
  const row = await database.pool.query<{ id: string }>(
    `insert into seer.matters
       (account_id, title, org_unit, function_name, short_title,
        short_title_source, short_title_version)
     values ($1, $2, 'Roche', $3, $4, $5, $6)
     returning id`,
    [
      accountId,
      title,
      fields.functionName ?? null,
      fields.shortTitle ?? null,
      fields.shortTitleSource ?? "inferred",
      fields.shortTitleVersion ?? null,
    ],
  );
  return row.rows[0].id;
}

async function addDecidedConversation(
  accountId: AccountId,
  subject: string,
): Promise<string> {
  const row = await database.pool.query<{ id: string }>(
    `insert into seer.conversations
       (account_id, provider_conversation_id, subject, last_message_at, folders)
     values ($1, $2, $3, now() - interval '2 days', array['inbox']::text[])
     returning id`,
    [accountId, `provider-${subject}`, subject],
  );
  const conversationId = asConversationId(row.rows[0].id);
  await saveDecision({
    accountId,
    conversationId,
    home: "record",
    proposedHome: "record",
    summary: "Invoice to keep",
    rationale: "A receipt, not live work",
    owner: "nobody",
    ask: "nothing — informational",
    vetoReasons: [],
    yields: [],
    evidence: [],
  });
  return conversationId;
}

async function runGmailPush(accountId: AccountId): Promise<Response> {
  const emailRow = await database.pool.query<{ email: string }>(
    "select email from seer.mail_accounts where id = $1",
    [accountId],
  );
  const email = emailRow.rows[0].email;
  const request = new Request("https://example.com/api/webhooks/gmail", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      message: {
        data: Buffer.from(
          JSON.stringify({ emailAddress: email, historyId: "1" }),
          "utf8",
        ).toString("base64"),
        messageId: `push-${accountId}`,
      },
    }),
  });
  const closers: Array<(value?: unknown) => void> = [];
  const pending: Array<Promise<unknown>> = [];
  const afterErrors: unknown[] = [];
  const store = {
    page: "/api/webhooks/gmail",
    pendingRevalidatedTags: [] as string[],
    pendingRevalidates: {},
    pendingRevalidateWrites: [] as unknown[],
    afterContext: new AfterContext({
      waitUntil: (task: Promise<unknown>) => {
        pending.push(task);
      },
      onClose: (done: (value?: unknown) => void) => {
        closers.push(done);
      },
      onTaskError: (error: unknown) => {
        afterErrors.push(error);
      },
    }),
  };
  const response = await workAsyncStorage.run(store, async () => {
    const result = await gmailPush(request);
    for (const done of closers) done();
    await Promise.all(pending);
    return result;
  });
  assert.equal(afterErrors.length, 0, "gmail push background wake threw");
  const body = (await response.clone().json()) as { waking?: string; ignored?: string };
  assert.equal(response.status, 200);
  assert.equal(body.waking, email, "unauthenticated gmail push did not wake the mailbox");
  return response;
}

async function runReadCron(accountId: AccountId): Promise<{ filing?: { matters?: { attempted?: number }; conversations?: { attempted?: number }; naming?: { attempted?: number }; error?: string } }> {
  const request = new Request(
    `https://example.com/api/v2/read?accountId=${accountId}`,
    { headers: { authorization: `Bearer ${PLACEHOLDER}` } },
  );
  const response = await readCron(request);
  assert.equal(response.status, 200);
  const body = (await response.json()) as {
    report?: Array<{ error?: string; filing?: { error?: string } }>;
  };
  const report = body.report?.[0];
  assert.equal(report?.error, undefined, "read cron did not reach filing");
  assert.equal(
    (report?.filing as { error?: string } | undefined)?.error,
    undefined,
    "filing threw instead of consulting the daily budget",
  );
  return report ?? {};
}

async function sections(accountId: AccountId) {
  const matters = await database.pool.query<{
    function_name: string | null;
    short_title: string | null;
  }>(
    `select function_name, short_title
       from seer.matters where account_id = $1 order by title`,
    [accountId],
  );
  const conversations = await database.pool.query<{ function_name: string | null }>(
    `select function_name from seer.conversations where account_id = $1`,
    [accountId],
  );
  return {
    matters: matters.rows,
    conversations: conversations.rows,
  };
}

const failures: string[] = [];

async function scenario(name: string, fn: () => Promise<void>) {
  modelCalls.length = 0;
  exhaustAccountId = null;
  try {
    await fn();
    console.log(`PASS ${name}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    failures.push(`${name}: ${message}`);
    console.error(`FAIL ${name}: ${message}`);
  }
}

try {
  await scenario(
    "under budget, gmail push files and names through the gateway",
    async () => {
      setBudget("100", undefined);
      const accountId = await openMailbox("under-budget");
      await addMatter(accountId, "Roche stability amendment");
      await addDecidedConversation(accountId, "Roche invoice");
      assert.equal(await withinDailyBudget(accountId, "fast"), true);
      await runGmailPush(accountId);
      const kinds = modelCalls.map((call) => call.kind);
      assert.deepEqual(kinds.filter((kind) => kind === "reader"), []);
      assert.ok(kinds.includes("filing"), `expected a filing gateway call, saw ${kinds.join(",")}`);
      assert.ok(kinds.includes("naming"), `expected a naming gateway call, saw ${kinds.join(",")}`);
      assert.ok(kinds.every((kind) => kind === "filing" || kind === "naming"));
    },
  );

  await scenario(
    "gmail push does not file or name once the fast daily call ceiling is spent",
    async () => {
      setBudget("1", undefined);
      const accountId = await openMailbox("call-ceiling");
      for (let i = 0; i < 41; i++) {
        await addMatter(accountId, `Unfiled matter ${i}`, {
          shortTitle: i === 0 ? "Old Roche label" : null,
          shortTitleSource: i === 0 ? "inferred" : null,
          shortTitleVersion: i === 0 ? 0 : null,
        });
      }
      await addDecidedConversation(accountId, "Unfiled receipt");
      await recordModelUsage({
        accountId,
        tier: "fast",
        model: "google/gemini-3.1-flash-lite",
        escalationReasons: ["reader"],
        latencyMs: 1,
        inputTokens: 1,
        outputTokens: 1,
        totalTokens: 2,
        costUsd: 0,
      });
      assert.equal(await withinDailyCallLimit(accountId, "fast"), false);
      assert.equal(await withinDailyBudget(accountId, "fast"), false);
      const before = await sections(accountId);
      await runGmailPush(accountId);
      assert.deepEqual(
        modelCalls.map((call) => call.kind),
        [],
        "filing and naming called the gateway after the fast daily ceiling",
      );
      assert.deepEqual(await sections(accountId), before, "filing wrote shelves before refusing");
    },
  );

  await scenario(
    "read cron does not file or name once the daily spend cap is spent",
    async () => {
      setBudget("1000", "1");
      const accountId = await openMailbox("spend-cap");
      await addMatter(accountId, "Untitled Roche matter");
      await addDecidedConversation(accountId, "Untitled receipt");
      await recordModelUsage({
        accountId,
        tier: "fast",
        model: "google/gemini-3.1-flash-lite",
        escalationReasons: ["reader"],
        latencyMs: 1,
        inputTokens: 10,
        outputTokens: 2,
        totalTokens: 12,
        costUsd: 5,
      });
      assert.equal(await withinDailyCallLimit(accountId, "fast"), true);
      assert.equal(await withinDailyBudget(accountId, "fast"), false);
      const before = await sections(accountId);
      const report = await runReadCron(accountId);
      assert.deepEqual(
        modelCalls.map((call) => call.kind),
        [],
        "read tick called the gateway after the dollar cap",
      );
      assert.deepEqual(await sections(accountId), before, "read tick wrote shelves before refusing");
      void report;
    },
  );

  await scenario(
    "naming still calls the gateway when only titles are stale and the call ceiling is spent",
    async () => {
      setBudget("1", undefined);
      const accountId = await openMailbox("naming-only");
      await addMatter(accountId, "Filed but untitled", {
        functionName: "hr",
        shortTitle: null,
      });
      await recordModelUsage({
        accountId,
        tier: "fast",
        model: "google/gemini-3.1-flash-lite",
        escalationReasons: ["reader"],
        latencyMs: 1,
        inputTokens: 1,
        outputTokens: 1,
        totalTokens: 2,
        costUsd: 0,
      });
      assert.equal(await withinDailyBudget(accountId, "fast"), false);
      const before = await sections(accountId);
      await runGmailPush(accountId);
      assert.deepEqual(modelCalls.map((call) => call.kind), []);
      assert.deepEqual(await sections(accountId), before);
    },
  );

  await scenario(
    "conversation filing still calls the gateway when matters need nothing and the call ceiling is spent",
    async () => {
      setBudget("1", undefined);
      const accountId = await openMailbox("conversation-only");
      await addMatter(accountId, "Already named", {
        functionName: "hr",
        shortTitle: "Roche hiring",
        shortTitleSource: "user",
        shortTitleVersion: 1,
      });
      await addDecidedConversation(accountId, "Loose receipt");
      await recordModelUsage({
        accountId,
        tier: "fast",
        model: "google/gemini-3.1-flash-lite",
        escalationReasons: ["reader"],
        latencyMs: 1,
        inputTokens: 1,
        outputTokens: 1,
        totalTokens: 2,
        costUsd: 0,
      });
      assert.equal(await withinDailyBudget(accountId, "fast"), false);
      const before = await sections(accountId);
      await runReadCron(accountId);
      assert.deepEqual(modelCalls.map((call) => call.kind), []);
      assert.deepEqual(await sections(accountId), before);
    },
  );

  await scenario(
    "a budget row that lands after the unfiled-matter lookup still blocks the gateway call",
    async () => {
      setBudget("1", undefined);
      const accountId = await openMailbox("stale-check");
      await addMatter(accountId, "Matter listed before the budget moved");
      await addDecidedConversation(accountId, "Receipt listed before the budget moved");
      assert.equal(await withinDailyBudget(accountId, "fast"), true);
      exhaustAccountId = accountId;
      const before = await sections(accountId);
      await runReadCron(accountId);
      assert.equal(
        await withinDailyBudget(accountId, "fast"),
        false,
        "the unfiled-matter query did not observe the concurrent usage row",
      );
      assert.deepEqual(
        modelCalls.map((call) => call.kind),
        [],
        "the model call reused a budget look-up from before the usage row landed",
      );
      assert.deepEqual(await sections(accountId), before);
    },
  );

  await scenario(
    "one remaining fast call cannot cover a second filing batch or naming",
    async () => {
      setBudget("1", undefined);
      const accountId = await openMailbox("one-slot");
      for (let i = 0; i < 41; i++) {
        await addMatter(accountId, `Board item ${i.toString().padStart(2, "0")}`);
      }
      await addDecidedConversation(accountId, "Second batch receipt");
      assert.equal(await withinDailyBudget(accountId, "fast"), true);
      await runGmailPush(accountId);
      assert.deepEqual(
        modelCalls.map((call) => call.kind),
        ["filing"],
        "later filing and naming calls did not re-read the budget after the first call was recorded",
      );
      const after = await sections(accountId);
      const unnamed = after.matters.filter((row) => row.function_name == null);
      assert.equal(unnamed.length, 1, "a later matter batch was filed without a fresh budget check");
      assert.ok(after.matters.every((row) => row.short_title == null));
      assert.ok(after.conversations.every((row) => row.function_name == null));
    },
  );

  if (failures.length > 0) {
    console.error(`v2-filing-budget: ${failures.length} failed`);
  } else {
    console.log("v2-filing-budget: OK");
  }
} finally {
  globalThis.fetch = originalFetch;
  await database.stop();
}

if (failures.length > 0) process.exit(1);
