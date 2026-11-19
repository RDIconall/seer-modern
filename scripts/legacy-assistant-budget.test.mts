/**
 * Spec for the legacy assistant's shared model budget.
 *
 * These tests fail while a signed-in mailbox can call the shared Gemini or
 * AI Gateway model with no per-account daily ceiling. They pass once every
 * legacy model call below reserves a row in seer.model_usage and refuses
 * before the provider is contacted when that account is over the same daily
 * call and spend ceiling the v2 reader uses (withinDailyBudget).
 *
 * Run:
 *   npx tsx --tsconfig tsconfig.legacy-budget.json scripts/legacy-assistant-budget.test.mts
 *
 * The script adds the embedded Postgres lib directory to LD_LIBRARY_PATH
 * before booting the throwaway database, the same database harness as
 * scripts/v2-testdb.mts.
 *
 * tsconfig.legacy-budget.json maps @/auth to scripts/legacy-budget-auth-double.ts
 * so the test can supply the signed-in mailbox. requireMailSession, the route
 * handlers, classifyInboxWithAssistant, and buildBrief still run.
 *
 * Contract:
 * - POST /api/assist/draft, GET /api/unsub-agent, the inbox classifier used by
 *   GET /api/mailbox, GET /api/today, and GET /api/alltasks, and the brief
 *   rebuild in POST /api/brief (buildBrief) each refuse before any provider
 *   HTTP when withinDailyBudget(accountId, "fast") or withinDailyBudget(
 *   accountId, "strong") is false for every tier they might record.
 * - A call that is allowed inserts a seer.model_usage row for THAT account
 *   with tier "fast" or "strong" and commits it before the provider request
 *   is sent. A second concurrent request must not also pass a ceiling of 1.
 * - POST /api/assist/draft and GET /api/unsub-agent also enforce
 *   SEER_LEGACY_ROUTE_PER_MINUTE (default 8): at most that many model
 *   attempts per account in any 60 second window, refused with 429 or 503
 *   before the provider is contacted. Another account is not counted.
 * - A provider quota / 429 / RESOURCE_EXHAUSTED response may record one
 *   shared cooldown that makes other mailboxes skip the direct Google host.
 *   The account that received the error must not send another model request
 *   on that turn or a later turn, including a gateway failover.
 * - A non-quota provider error must not move other mailboxes off the direct
 *   Google host.
 *
 * Not covered here, and why:
 * - GET /api/catchup and GET /api/messages/[id] pass geminiEnabled: false and
 *   are checked only as controls that they do not call the model.
 * - src/lib/inbox/understanding.ts readEmails and the legacy cron's second
 *   buildBrief run only when SEER_LEGACY_CRON=on (default off) and, when
 *   CRON_SECRET is set, only with that operator secret.
 * - POST /api/v2/bakeoff is preview-only and guarded by BAKEOFF_SECRET.
 */
import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";
import { mkdir, mkdtemp, readdir, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { startTestDb, type TestDb } from "./v2-testdb.mts";

// Next's request store uses globalThis.AsyncLocalStorage, which Node does not
// set. Install it before any Next module loads or workAsyncStorage.run throws.
(globalThis as { AsyncLocalStorage?: typeof AsyncLocalStorage }).AsyncLocalStorage =
  AsyncLocalStorage;
import { type AccountId } from "../src/lib/v2/db/types.ts";
import { upsertAccountWithCredentials, upsertUser } from "../src/lib/v2/db/accounts.ts";
import { recordModelUsage, withinDailyBudget } from "../src/lib/v2/intelligence/model-usage.ts";

const PLACEHOLDER = "test-placeholder";
const dataDir = await mkdtemp(path.join(tmpdir(), "seer-legacy-budget-"));
// The embedded Postgres package ships versioned libraries (libpq.so.5.18)
// without the SONAME symlink initdb loads (libpq.so.5). Point the loader at
// a directory of those links. This is the same binary scripts/v2-testdb.mts boots.
const embeddedLib = path.join(
  process.cwd(),
  "node_modules/@embedded-postgres/linux-x64/native/lib",
);
const loaderLib = path.join(dataDir, "lib");
await mkdir(loaderLib);
for (const name of await readdir(embeddedLib)) {
  if (!name.includes(".so")) continue;
  const source = path.join(embeddedLib, name);
  await symlink(source, path.join(loaderLib, name));
  const soname = name.replace(/(\.so\.\d+)\.\d+$/, "$1");
  if (soname !== name) {
    await symlink(source, path.join(loaderLib, soname)).catch(() => {});
  }
}
process.env.LD_LIBRARY_PATH = [loaderLib, process.env.LD_LIBRARY_PATH]
  .filter(Boolean)
  .join(":");

process.env.SEER_DATA_DIR = dataDir;
process.env.NODE_ENV = "test";
process.env.GOOGLE_GENERATIVE_AI_API_KEY = PLACEHOLDER;
process.env.SEER_GEMINI_MODEL = "gemini-2.5-flash";
delete process.env.GEMINI_API_KEY;
delete process.env.AI_GATEWAY_API_KEY;
delete process.env.VERCEL_OIDC_TOKEN;
delete process.env.VERCEL;
delete process.env.POSTGRES_URL;
delete process.env.SEER_V2_DATABASE_URL;
delete process.env.UPSTASH_REDIS_REST_URL;
delete process.env.UPSTASH_REDIS_REST_TOKEN;
delete process.env.KV_REST_API_URL;
delete process.env.KV_REST_API_TOKEN;

type SessionGlobal = typeof globalThis & {
  __seerTestSessionEmail?: string | null;
};
(globalThis as SessionGlobal).__seerTestSessionEmail = null;

const { RequestCookies } = await import(
  "next/dist/server/web/spec-extension/cookies.js"
);
const { AfterContext } = await import("next/dist/server/after/after-context.js");
const { workAsyncStorage } = await import(
  "next/dist/server/app-render/work-async-storage.external.js"
);
const { workUnitAsyncStorage } = await import(
  "next/dist/server/app-render/work-unit-async-storage.external.js"
);
const { kvDelete } = await import("../src/lib/store/kv.ts");
const draftRoute = await import("../src/app/api/assist/draft/route.ts");
const unsubRoute = await import("../src/app/api/unsub-agent/route.ts");
const mailboxRoute = await import("../src/app/api/mailbox/route.ts");
const todayRoute = await import("../src/app/api/today/route.ts");
const allTasksRoute = await import("../src/app/api/alltasks/route.ts");
const briefRoute = await import("../src/app/api/brief/route.ts");
const catchupRoute = await import("../src/app/api/catchup/route.ts");
const messageRoute = await import("../src/app/api/messages/[id]/route.ts");

type ModelKind = "google" | "gateway";
type ModelHit = { kind: ModelKind; reserved: boolean };

let listCount = 1;
let messageId = "m1";
let modelMode: "ok" | "quota" | "error" | "hold" = "ok";
let requireReservation = false;
let activeAccountId: AccountId | null = null;
let hits: ModelHit[] = [];
let releaseSecond: (() => void) | null = null;
let secondArrived: Promise<void> | null = null;
const database: TestDb = await startTestDb();

function resetTransport() {
  hits = [];
  modelMode = "ok";
  requireReservation = false;
  listCount = 1;
  messageId = "m1";
  releaseSecond = null;
  secondArrived = null;
}

function modelHits(kind?: ModelKind): ModelHit[] {
  return kind ? hits.filter((hit) => hit.kind === kind) : hits;
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function messageBody(id: string) {
  const text = Buffer.from(
    "Please look at the timeline when you can.",
    "utf8",
  ).toString("base64");
  return {
    id,
    threadId: `t-${id}`,
    snippet: "Please look at the timeline when you can.",
    internalDate: String(Date.now()),
    labelIds: ["INBOX", "UNREAD"],
    payload: {
      mimeType: "text/plain",
      body: { data: text, size: text.length },
      headers: [
        { name: "From", value: "Alex Rivera <alex@example.com>" },
        { name: "To", value: "owner@rditrials.com" },
        { name: "Subject", value: "Question about the timeline" },
      ],
    },
  };
}

function listedMessages() {
  return Array.from({ length: listCount }, (_, index) => {
    const id = listCount === 1 ? messageId : `m${index + 1}`;
    return { id, threadId: `t-${id}` };
  });
}

function gmailResponse(url: URL, init?: RequestInit): Response {
  const pathname = url.pathname;
  const method = (init?.method ?? "GET").toUpperCase();
  if (pathname.endsWith("/users/me/messages") && method === "GET") {
    const q = url.searchParams.get("q") ?? "";
    const inbox = q.includes("in:inbox") && !q.includes("-in:inbox");
    return json(200, { messages: inbox ? listedMessages() : [] });
  }
  const message = pathname.match(/\/messages\/([^/]+)$/);
  if (message && method === "GET") return json(200, messageBody(message[1]));
  if (pathname.includes("/threads/") && method === "GET") {
    const id = pathname.split("/threads/")[1]?.split("/")[0] ?? "m1";
    const bare = id.replace(/^t-/, "");
    if (url.searchParams.get("format") === "minimal") {
      return json(200, { messages: [{ id: bare.startsWith("m") ? bare : "m1" }] });
    }
    return json(200, {
      messages: [messageBody(bare.startsWith("m") ? bare : "m1")],
    });
  }
  if (pathname.endsWith("/labels/INBOX")) {
    return json(200, { messagesTotal: listCount, threadsTotal: listCount });
  }
  if (pathname.endsWith("/users/me/labels") && method === "POST") {
    return json(200, { id: "Label_1" });
  }
  if (pathname.endsWith("/users/me/labels")) return json(200, { labels: [] });
  if (pathname.endsWith("/batchModify")) return new Response(null, { status: 204 });
  return json(404, { error: "unstubbed gmail" });
}

function outputFor(body: string): string {
  if (body.includes("draft email replies")) {
    return JSON.stringify({ body: "Thanks, I will look today.\n\nPat" });
  }
  if (body.includes("unsubscribe agent")) {
    return JSON.stringify({
      senders: [
        {
          email: "alex@example.com",
          unsubscribe: true,
          phoneDup: false,
          reason: "Bulk mail you never read",
        },
      ],
    });
  }
  if (body.includes("chief of staff") || body.includes("MATTERS")) {
    return JSON.stringify({
      summary: "One open question about a timeline.",
      matters: [
        {
          id: "timeline",
          title: "Timeline question",
          goal: "Alex has an answer",
          category: "People",
          orgUnit: "General",
          orgConfidence: 0.4,
          people: [
            {
              name: "Alex Rivera",
              email: "alex@example.com",
              relationship: "prospect",
            },
          ],
          narrative: "Alex asked about the timeline.",
          nextAction: "Reply with the date",
          owner: "you",
          urgency: 1,
          status: "active",
          emailIds: ["m1"],
        },
      ],
    });
  }
  if (body.includes("disposable end")) {
    return JSON.stringify({
      summary: "Nothing that needs a reply.",
      themes: [{ theme: "Notes", line: "One note.", emailIds: ["m1"] }],
    });
  }
  const id = body.match(/"id":"(m[^"]+)"/)?.[1] ?? messageId;
  return JSON.stringify({
    items: [
      {
        id,
        action: "needs_review",
        confidence: 0.4,
        reason: "Unclear ask",
        instruction: "Skim it",
        task: "none",
        sender: "machine",
        credible: false,
        importance: 1,
        deed: "none",
      },
    ],
  });
}

async function reservedRows(): Promise<number> {
  if (!activeAccountId) return 0;
  const result = await database.pool.query<{ n: number }>(
    `select count(*)::int as n from seer.model_usage where account_id = $1`,
    [activeAccountId],
  );
  return result.rows[0]?.n ?? 0;
}

async function modelResponse(kind: ModelKind, init?: RequestInit): Promise<Response> {
  const raw = typeof init?.body === "string" ? init.body : "";
  const already = await reservedRows();
  const hit: ModelHit = { kind, reserved: already >= 1 };
  hits.push(hit);
  if (modelMode === "hold") {
    if (hits.length === 1) {
      secondArrived = new Promise((resolve) => {
        releaseSecond = resolve;
      });
      await Promise.race([
        secondArrived,
        new Promise((resolve) => setTimeout(resolve, 400)),
      ]);
    } else {
      releaseSecond?.();
    }
  }
  if (modelMode === "quota" && kind === "google") {
    return json(429, {
      error: {
        code: 429,
        message:
          "Quota exceeded for metric generativelanguage.googleapis.com/generate_content_free_tier_requests. Please retry in 30s.",
        status: "RESOURCE_EXHAUSTED",
      },
    });
  }
  if (modelMode === "error") {
    return json(500, {
      error: {
        code: 500,
        message: "internal error",
        status: "INTERNAL",
      },
    });
  }
  return json(200, {
    candidates: [
      {
        content: { role: "model", parts: [{ text: outputFor(raw) }] },
        finishReason: "STOP",
      },
    ],
    usageMetadata: {
      promptTokenCount: 12,
      candidatesTokenCount: 8,
      totalTokenCount: 20,
    },
  });
}

const originalFetch = globalThis.fetch;
globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(
    typeof input === "string"
      ? input
      : input instanceof URL
        ? input.toString()
        : input.url,
  );
  if (url.hostname === "generativelanguage.googleapis.com" && url.pathname.includes(":generateContent")) {
    return modelResponse("google", init);
  }
  if (url.hostname === "ai-gateway.vercel.sh" && url.pathname.includes("/language-model")) {
    return modelResponse("gateway", init);
  }
  if (url.hostname === "gmail.googleapis.com") return gmailResponse(url, init);
  if (url.hostname === "people.googleapis.com") {
    return json(200, { connections: [], otherContacts: [] });
  }
  if (url.hostname === "www.googleapis.com") return json(200, { items: [] });
  return json(404, { error: "unstubbed" });
};

async function inRequest<T>(route: string, run: () => Promise<T>): Promise<T> {
  const pending: Promise<unknown>[] = [];
  let close = () => {};
  const afterContext = new AfterContext({
    waitUntil(task) {
      pending.push(Promise.resolve(task));
    },
    onClose(done) {
      close = done;
    },
  });
  const jar = new RequestCookies(new Headers());
  const result = await workAsyncStorage.run(
    { route, afterContext },
    () =>
      workUnitAsyncStorage.run(
        {
          type: "request",
          phase: "action",
          cookies: jar,
          mutableCookies: jar,
          userspaceMutableCookies: jar,
        },
        run,
      ),
  );
  close();
  await Promise.allSettled(pending);
  return result;
}

const runId = Math.random().toString(36).slice(2, 8);

async function signIn(email: string): Promise<AccountId> {
  email = email.replace("@", `-${runId}@`);
  (globalThis as SessionGlobal).__seerTestSessionEmail = email;
  const userId = await upsertUser(email);
  const account = await upsertAccountWithCredentials({
    userId,
    provider: "google",
    email,
    displayName: "Tester",
    accessToken: "mailbox-access-placeholder",
    expiresAt: Date.now() + 60 * 60 * 1000,
  });
  activeAccountId = account.id;
  return account.id;
}

function ceilings(input: {
  fast: string;
  strong: string;
  spend?: string;
  perMinute?: string;
}) {
  process.env.SEER_FAST_DAILY_CALL_LIMIT = input.fast;
  process.env.SEER_STRONG_DAILY_CALL_LIMIT = input.strong;
  if (input.spend === undefined) delete process.env.SEER_DAILY_SPEND_LIMIT_USD;
  else process.env.SEER_DAILY_SPEND_LIMIT_USD = input.spend;
  if (input.perMinute === undefined) delete process.env.SEER_LEGACY_ROUTE_PER_MINUTE;
  else process.env.SEER_LEGACY_ROUTE_PER_MINUTE = input.perMinute;
}

async function clearCooldown() {
  await kvDelete("gemini-cooldown");
}

async function seedUsage(
  accountId: AccountId,
  tier: "fast" | "strong",
  costUsd?: number,
) {
  await recordModelUsage({
    accountId,
    tier,
    model: "gemini-2.5-flash",
    escalationReasons: [],
    latencyMs: 1,
    costUsd,
  });
}

function assertNoUnreserved(label: string) {
  if (!requireReservation) return;
  const missed = hits.filter((hit) => !hit.reserved);
  assert.equal(
    missed.length,
    0,
    `${label} contacted the provider before a seer.model_usage row for the signed-in account was committed`,
  );
}

async function draft(id = "m1"): Promise<Response> {
  return inRequest("POST /api/assist/draft", () =>
    draftRoute.POST(
      new Request("http://localhost/api/assist/draft", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id }),
      }),
    ),
  );
}

const failures: string[] = [];

async function check(name: string, run: () => Promise<void>) {
  resetTransport();
  await clearCooldown();
  delete process.env.AI_GATEWAY_API_KEY;
  console.log(`\nRUN ${name}`);
  try {
    await run();
    console.log(`PASS ${name}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.log(`FAIL ${name}: ${message}`);
    failures.push(`${name}: ${message}`);
  }
}

try {
  await check("controls do not call the model", async () => {
    ceilings({ fast: "100", strong: "100" });
    const email = "control@rditrials.com";
    await signIn(email);
    const message = await inRequest("GET /api/messages/m1", () =>
      messageRoute.GET(new Request("http://localhost/api/messages/m1"), {
        params: Promise.resolve({ id: "m1" }),
      }),
    );
    assert.equal(message.status, 200, await message.text());
    assert.equal(modelHits().length, 0, "message load called the model");

    resetTransport();
    const first = await inRequest("GET /api/catchup", () =>
      catchupRoute.GET(new Request("http://localhost/api/catchup")),
    );
    assert.equal(first.status, 200);
    listCount = 3;
    const second = await inRequest("GET /api/catchup", () =>
      catchupRoute.GET(new Request("http://localhost/api/catchup")),
    );
    assert.equal(second.status, 200, await second.clone().text());
    assert.equal(
      modelHits().length,
      0,
      "catchup called the model even though gemini is disabled on that route",
    );
  });

  await check("draft does not call the provider once either daily ceiling is exhausted", async () => {
    ceilings({ fast: "1", strong: "1" });
    const accountId = await signIn("draft-exhausted@rditrials.com");
    await seedUsage(accountId, "fast");
    await seedUsage(accountId, "strong");
    assert.equal(await withinDailyBudget(accountId, "fast"), false);
    assert.equal(await withinDailyBudget(accountId, "strong"), false);
    const response = await draft();
    assert.equal(
      modelHits().length,
      0,
      `draft called the shared model ${modelHits().length} time(s) and returned ${response.status}`,
    );
  });

  await check("draft reserves usage then stops at the daily ceiling", async () => {
    ceilings({ fast: "1", strong: "1" });
    const accountId = await signIn("draft-budget@rditrials.com");
    requireReservation = true;
    const first = await draft();
    assert.equal(first.status, 200, await first.text());
    assert.equal(modelHits().length, 1);
    assertNoUnreserved("draft");
    const rows = await database.pool.query<{ tier: string }>(
      `select tier from seer.model_usage where account_id = $1`,
      [accountId],
    );
    assert.equal(rows.rowCount, 1);
    assert.ok(rows.rows[0].tier === "fast" || rows.rows[0].tier === "strong");
    assert.equal(
      await withinDailyBudget(accountId, rows.rows[0].tier as "fast" | "strong"),
      false,
    );

    const before = hits.length;
    requireReservation = false;
    const second = await draft();
    assert.ok(
      second.status === 429 || second.status === 503,
      `second draft status ${second.status}`,
    );
    assert.equal(hits.length, before, "draft over the daily ceiling still called the provider");
  });

  await check("draft stops at the shared daily spend ceiling", async () => {
    ceilings({ fast: "100", strong: "100", spend: "1" });
    const accountId = await signIn("draft-spend@rditrials.com");
    await seedUsage(accountId, "fast", 5);
    assert.equal(await withinDailyBudget(accountId, "fast"), false);
    const response = await draft();
    assert.ok(response.status === 429 || response.status === 503, `status ${response.status}`);
    assert.equal(modelHits().length, 0, "spend ceiling did not stop the draft provider call");
  });

  await check("draft rate limit is per account", async () => {
    ceilings({ fast: "100", strong: "100", perMinute: "2" });
    await signIn("draft-rate-a@rditrials.com");
    requireReservation = true;
    const first = await draft();
    const second = await draft();
    assert.equal(first.status, 200, await first.text());
    assert.equal(second.status, 200, await second.text());
    assert.equal(modelHits().length, 2);
    assertNoUnreserved("draft rate limit");
    const third = await draft();
    assert.ok(third.status === 429 || third.status === 503, `status ${third.status}`);
    assert.equal(modelHits().length, 2, "third draft in the window still called the provider");

    await signIn("draft-rate-b@rditrials.com");
    const other = await draft();
    assert.equal(other.status, 200, await other.text());
    assert.equal(modelHits().length, 3, "a second account was blocked by the first account's rate limit");
  });

  await check("parallel drafts cannot both pass a one-call ceiling", async () => {
    ceilings({ fast: "1", strong: "1" });
    await signIn("draft-race@rditrials.com");
    modelMode = "hold";
    requireReservation = true;
    const [left, right] = await Promise.all([draft("m1"), draft("m1")]);
    assert.equal(modelHits().length, 1, "both parallel drafts reached the provider");
    assertNoUnreserved("parallel draft");
    const statuses = [left.status, right.status].sort();
    assert.ok(
      statuses.includes(429) || statuses.includes(503),
      `expected one refusal, got ${statuses.join(",")}`,
    );
  });

  await check("unsubscribe agent uses the same ceiling and rate limit", async () => {
    ceilings({ fast: "1", strong: "1", perMinute: "2" });
    const blocked = await signIn("unsub-blocked@rditrials.com");
    await seedUsage(blocked, "fast");
    await seedUsage(blocked, "strong");
    assert.equal(await withinDailyBudget(blocked, "fast"), false);
    const refused = await inRequest("GET /api/unsub-agent", () =>
      unsubRoute.GET(),
    );
    const refusedText = await refused.text();
    assert.equal(
      modelHits().length,
      0,
      `unsubscribe agent ignored the daily ceiling (${refused.status} ${refusedText})`,
    );
    assert.ok(
      refused.status === 429 || refused.status === 503,
      `status ${refused.status} ${refusedText}`,
    );

    resetTransport();
    ceilings({ fast: "100", strong: "100", perMinute: "2" });
    await signIn("unsub-ok@rditrials.com");
    requireReservation = true;
    const allowed = await inRequest("GET /api/unsub-agent", () => unsubRoute.GET());
    assert.equal(allowed.status, 200, await allowed.text());
    assert.equal(modelHits().length, 1, "unsubscribe agent did not call the model for a live candidate");
    assertNoUnreserved("unsubscribe agent");
    const again = await inRequest("GET /api/unsub-agent", () => unsubRoute.GET());
    const third = await inRequest("GET /api/unsub-agent", () => unsubRoute.GET());
    assert.equal(again.status, 200);
    assert.ok(third.status === 429 || third.status === 503, `status ${third.status}`);
    assert.equal(modelHits().length, 2, "unsubscribe agent ignored the per-minute limit");
  });

  await check("parallel unsubscribe calls cannot both pass a one-call ceiling", async () => {
    ceilings({ fast: "1", strong: "1" });
    await signIn("unsub-race@rditrials.com");
    modelMode = "hold";
    requireReservation = true;
    const [left, right] = await Promise.all([
      inRequest("GET /api/unsub-agent", () => unsubRoute.GET()),
      inRequest("GET /api/unsub-agent", () => unsubRoute.GET()),
    ]);
    assert.equal(modelHits().length, 1, "both unsubscribe calls reached the provider");
    assertNoUnreserved("parallel unsubscribe");
    const statuses = [left.status, right.status];
    assert.ok(statuses.includes(429) || statuses.includes(503), statuses.join(","));
  });

  async function classify(which: "mailbox" | "today" | "alltasks") {
    const request = new Request(`http://localhost/api/${which}`);
    if (which === "mailbox") {
      return inRequest("GET /api/mailbox", () => mailboxRoute.GET(request));
    }
    if (which === "today") {
      return inRequest("GET /api/today", () => todayRoute.GET());
    }
    return inRequest("GET /api/alltasks", () => allTasksRoute.GET());
  }

  await check("classifier routes reserve usage and honor the daily ceiling", async () => {
    ceilings({ fast: "100", strong: "100" });
    await signIn("classify-ok@rditrials.com");
    requireReservation = true;
    const classifyNotes: string[] = [];
    for (const which of ["alltasks", "mailbox", "today"] as const) {
      resetTransport();
      messageId = `m-${which}`;
      await signIn(`classify-ok-${which}@rditrials.com`);
      requireReservation = true;
      const response = await classify(which);
      const text = await response.text();
      if (response.status !== 200) {
        classifyNotes.push(`${which} status ${response.status} ${text.slice(0, 180)}`);
      }
      if (hits.length === 0) {
        classifyNotes.push(`${which} did not call the model for uncached gray mail`);
      }
      const missed = hits.filter((hit) => !hit.reserved);
      if (missed.length > 0) {
        classifyNotes.push(
          `${which} contacted the provider before a seer.model_usage row for the signed-in account was committed`,
        );
      }
    }
    assert.equal(classifyNotes.length, 0, classifyNotes.join("; "));

    ceilings({ fast: "1", strong: "1" });
    for (const which of ["alltasks", "mailbox", "today"] as const) {
      resetTransport();
      const accountId = await signIn(`classify-over-${which}@rditrials.com`);
      await seedUsage(accountId, "fast");
      await seedUsage(accountId, "strong");
      assert.equal(await withinDailyBudget(accountId, "fast"), false);
      const response = await classify(which);
      assert.equal(response.status, 200, `${which} ${response.status}`);
      assert.equal(
        modelHits().length,
        0,
        `${which} called the shared model after the daily ceiling was exhausted`,
      );
    }
  });

  await check("parallel classification cannot both pass a one-call ceiling", async () => {
    ceilings({ fast: "1", strong: "1" });
    await signIn("classify-race@rditrials.com");
    modelMode = "hold";
    requireReservation = true;
    await Promise.all([classify("alltasks"), classify("alltasks")]);
    assert.equal(modelHits().length, 1, "both classifications reached the provider");
    assertNoUnreserved("parallel classification");
  });

  await check("brief rebuild reserves usage and honors the daily ceiling", async () => {
    ceilings({ fast: "100", strong: "100" });
    await signIn("brief-ok@rditrials.com");
    requireReservation = true;
    const built = await inRequest("POST /api/brief", () => briefRoute.POST());
    assert.equal(built.status, 200, await built.text());
    assert.ok(modelHits().length >= 1, "brief rebuild did not call the model");
    assertNoUnreserved("brief");

    resetTransport();
    ceilings({ fast: "1", strong: "1" });
    const accountId = await signIn("brief-over@rditrials.com");
    await seedUsage(accountId, "fast");
    await seedUsage(accountId, "strong");
    const refused = await inRequest("POST /api/brief", () => briefRoute.POST());
    assert.equal(refused.status, 200, await refused.text());
    assert.equal(
      modelHits().length,
      0,
      "brief rebuild called the model after the daily ceiling was exhausted",
    );
  });

  await check("parallel brief rebuilds cannot both pass a one-call ceiling", async () => {
    ceilings({ fast: "1", strong: "1" });
    await signIn("brief-race@rditrials.com");
    modelMode = "hold";
    requireReservation = true;
    await Promise.all([
      inRequest("POST /api/brief", () => briefRoute.POST()),
      inRequest("POST /api/brief", () => briefRoute.POST()),
    ]);
    assert.equal(modelHits().length, 1, "both brief rebuilds reached the provider");
    assertNoUnreserved("parallel brief");
  });

  await check("quota cooldown does not let the caller keep calling", async () => {
    ceilings({ fast: "100", strong: "100" });
    process.env.AI_GATEWAY_API_KEY = PLACEHOLDER;
    await signIn("quota-caller@rditrials.com");
    requireReservation = true;
    modelMode = "quota";
    const loaded = await classify("alltasks");
    assert.equal(loaded.status, 200, await loaded.text());
    assert.equal(modelHits("google").length, 1, "the quota response never reached the classifier");
    assert.equal(
      modelHits("gateway").length,
      0,
      "the caller failed over to the gateway after its own quota error",
    );
    assertNoUnreserved("quota classification");
    const cooldown = await (await import("../src/lib/store/kv.ts")).kvGet<{
      until: number;
    }>("gemini-cooldown");
    assert.ok(cooldown && cooldown.until > Date.now(), "a real quota error did not record the shared cooldown");

    modelMode = "ok";
    requireReservation = false;
    const again = await draft();
    assert.ok(again.status === 429 || again.status === 503, `status ${again.status}`);
    assert.equal(
      modelHits().length,
      1,
      "the caller reached the provider again after causing the quota error",
    );

    await signIn("quota-other@rditrials.com");
    const other = await classify("alltasks");
    assert.equal(other.status, 200, await other.text());
    const added = hits.slice(1);
    assert.equal(
      added.filter((hit) => hit.kind === "google").length,
      0,
      "another mailbox still called the direct key during the shared cooldown",
    );
  });

  await check("a non-quota error does not move other mailboxes off the direct key", async () => {
    ceilings({ fast: "100", strong: "100" });
    process.env.AI_GATEWAY_API_KEY = PLACEHOLDER;
    await signIn("error-caller@rditrials.com");
    modelMode = "error";
    requireReservation = true;
    await classify("alltasks");
    assert.equal(modelHits("google").length, 1);
    assertNoUnreserved("non-quota classification");

    modelMode = "ok";
    requireReservation = false;
    await signIn("error-other@rditrials.com");
    const before = hits.length;
    await classify("alltasks");
    const added = hits.slice(before);
    assert.ok(
      added.some((hit) => hit.kind === "google"),
      "another mailbox left the direct key after a non-quota error",
    );
  });
} finally {
  globalThis.fetch = originalFetch;
  await database.stop();
  await rm(dataDir, { recursive: true, force: true });
}

if (failures.length > 0) {
  console.log(`\n${failures.length} test(s) failed`);
  for (const failure of failures) console.log(`- ${failure}`);
  process.exit(1);
}

console.log("\nlegacy-assistant-budget: OK");
