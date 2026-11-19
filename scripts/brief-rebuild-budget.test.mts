/**
 * Spec for the brief rebuild budget. These tests fail while a signed-in
 * mailbox can start overlapping rebuilds that call the shared model with no
 * daily budget. They pass once each model call is reserved against that
 * mailbox's budget first, and a second POST /api/brief for the same mailbox
 * is rejected before it fetches mail or calls the model.
 *
 * Run: npx tsx scripts/brief-rebuild-budget.test.mts
 */
import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";
import { createRequire, Module } from "node:module";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { EmailItem } from "../src/lib/inbox/types.ts";
import type { Understanding } from "../src/lib/inbox/understanding.ts";

globalThis.AsyncLocalStorage = AsyncLocalStorage;

/** src/lib/store/accounts.ts ACTIVE_ACCOUNT_COOKIE */
const ACTIVE_ACCOUNT_COOKIE = "seer_active_account";

const nodeRequire = createRequire(import.meta.url);
const realAi = nodeRequire("ai") as typeof import("ai");
const { AfterContext } = nodeRequire(
  "next/dist/server/after/after-context.js",
) as {
  AfterContext: new (opts: {
    waitUntil: (task: Promise<unknown>) => void;
    onClose: (done: () => void) => void;
    onTaskError: (error: unknown) => void;
  }) => {
    after: (task: unknown) => void;
  };
};
const { workAsyncStorage } = nodeRequire(
  "next/dist/server/app-render/work-async-storage.external.js",
) as {
  workAsyncStorage: {
    run: <T>(store: object, fn: () => T) => T;
  };
};

type ModelCall = { maxRetries: unknown; model: unknown; prompt: string };

const calls: ModelCall[] = [];
let hold: Promise<void> | null = null;
let sessionEmail: string | null = null;
let activeAccountId: string | null = null;
let gmailFetches = 0;
let inboxListGate: ((arrived: number) => Promise<void>) | null = null;

const dataDir = await mkdtemp(path.join(os.tmpdir(), "seer-brief-budget-"));
process.env.SEER_DATA_DIR = dataDir;
delete process.env.UPSTASH_REDIS_REST_URL;
delete process.env.KV_REST_API_URL;
delete process.env.UPSTASH_REDIS_REST_TOKEN;
delete process.env.KV_REST_API_TOKEN;
delete process.env.POSTGRES_URL;
delete process.env.POSTGRES_PRISMA_URL;
delete process.env.DATABASE_URL;
delete process.env.SEER_V2_DATABASE_URL;
delete process.env.GOOGLE_GENERATIVE_AI_API_KEY;
delete process.env.GEMINI_API_KEY;
delete process.env.AI_GATEWAY_API_KEY;
delete process.env.VERCEL_OIDC_TOKEN;
delete process.env.VERCEL;
delete process.env.SEER_DAILY_SPEND_LIMIT_USD;
process.env.NODE_ENV = "test";

const originalLoad = Module._load as (
  request: string,
  parent: NodeModule | undefined,
  isMain: boolean,
) => unknown;

function parentFile(parent: NodeModule | undefined): string {
  return parent?.filename ?? "";
}

function isAiRequest(request: string): boolean {
  return request === "ai" || request.includes(`${path.sep}node_modules${path.sep}ai${path.sep}`);
}

(Module as unknown as { _load: typeof originalLoad })._load = function (
  request: string,
  parent: NodeModule | undefined,
  isMain: boolean,
) {
  const from = parentFile(parent);
  if (isAiRequest(request) && from.includes(`${path.sep}matters.ts`)) {
    return new Proxy(realAi, {
      get(target, prop, receiver) {
        if (prop === "generateText") return instrumentedGenerateText;
        return Reflect.get(target, prop, receiver);
      },
    });
  }
  if (
    (request === "@/auth" || request.endsWith(`${path.sep}src${path.sep}auth.ts`)) &&
    from.includes(`${path.sep}session.ts`)
  ) {
    return { auth: testAuth };
  }
  if (
    (request === "next/headers" || request.includes("next/headers")) &&
    from.includes(`${path.sep}accounts.ts`)
  ) {
    return { cookies: testCookies, headers: async () => new Headers() };
  }
  return originalLoad(request, parent, isMain);
};

async function instrumentedGenerateText(options: {
  maxRetries?: unknown;
  model?: unknown;
  prompt?: unknown;
}) {
  calls.push({
    maxRetries: options.maxRetries,
    model: options.model,
    prompt: String(options.prompt ?? ""),
  });
  if (hold) await hold;
  const prompt = String(options.prompt ?? "");
  if (prompt.includes("previousMatters")) {
    return { output: { summary: "ok", matters: [] } };
  }
  return { output: { summary: "ok", themes: [] } };
}

async function testAuth() {
  if (!sessionEmail) return null;
  return {
    user: { email: sessionEmail, name: sessionEmail },
    provider: "google",
  };
}

async function testCookies() {
  return {
    get(name: string) {
      if (name === ACTIVE_ACCOUNT_COOKIE && activeAccountId) {
        return { name, value: activeAccountId };
      }
      return undefined;
    },
    set() {},
    delete() {},
  };
}

const originalFetch = globalThis.fetch;
globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
  const url =
    typeof input === "string"
      ? input
      : input instanceof URL
        ? input.href
        : input.url;
  if (url.startsWith("https://gmail.googleapis.com/")) {
    gmailFetches += 1;
    return gmailResponse(url);
  }
  if (
    url.startsWith("https://people.googleapis.com/") ||
    url.startsWith("https://www.googleapis.com/calendar/")
  ) {
    return new Response("permission missing", { status: 403 });
  }
  throw new Error(`brief budget test refused an unexpected request to ${new URL(url).host}`);
};

function gmailResponse(url: string): Response {
  const parsed = new URL(url);
  const query = parsed.searchParams.get("q") ?? "";
  if (parsed.pathname.endsWith("/labels/INBOX")) {
    return Response.json({ messagesTotal: 2, threadsTotal: 2 });
  }
  if (parsed.pathname.endsWith("/labels")) {
    return Response.json({ labels: [] });
  }
  if (parsed.pathname.includes("/threads/")) {
    const threadId = parsed.pathname.split("/threads/")[1]?.split("?")[0] ?? "t";
    return Response.json({
      messages: [
        {
          id: `${threadId}-last`,
          internalDate: "1700000000000",
          labelIds: ["INBOX"],
          payload: {
            headers: [
              { name: "From", value: "Vendor <one@vendor.example>" },
            ],
          },
        },
      ],
    });
  }
  if (parsed.pathname.endsWith("/messages") && query.includes("in:inbox")) {
    const gate = inboxListGate;
    const body = Response.json({
      messages: [
        { id: "in-1", threadId: "in-1" },
        { id: "in-2", threadId: "in-2" },
      ],
    });
    if (!gate) return body;
    const arrived = gmailFetches;
    return gate(arrived).then(() => body);
  }
  if (parsed.pathname.endsWith("/messages")) {
    return Response.json({ messages: [] });
  }
  const id = parsed.pathname.split("/messages/")[1]?.split("?")[0];
  if (id) {
    const n = id.endsWith("2") ? "2" : "1";
    return Response.json({
      id,
      threadId: id,
      snippet: "please review the attached note",
      internalDate: "1700000000000",
      labelIds: ["INBOX", "UNREAD"],
      payload: {
        headers: [
          { name: "From", value: `Vendor ${n} <vendor${n}@vendor.example>` },
          { name: "To", value: sessionEmail ?? "budget@rditrials.com" },
          { name: "Subject", value: `Matter note ${n}` },
        ],
      },
    });
  }
  return Response.json({});
}

const { buildBrief } = await import("../src/lib/inbox/matters.ts");
const { POST } = await import("../src/app/api/brief/route.ts");
const { startTestDb } = await import("./v2-testdb.mts");
const { upsertAccount, upsertUser, saveCredentials } = await import(
  "../src/lib/v2/db/accounts.ts"
);
const { recordModelUsage } = await import(
  "../src/lib/v2/intelligence/model-usage.ts"
);
const { db } = await import("../src/lib/v2/db/pool.ts");

const database = await startTestDb();

function matterItem(n: number): EmailItem {
  return {
    id: `matter-${n}`,
    threadId: `matter-thread-${n}`,
    fromEmail: `person${n}@counterparty${n}.example`,
    fromName: `Person ${n}`,
    subject: `Open item ${n}`,
    snippet: "need a decision",
    receivedAt: "2026-11-01T00:00:00.000Z",
    isUnread: true,
  };
}

function disposableUnderstanding(n: number): Understanding {
  return {
    id: `digest-${n}`,
    threadId: `digest-thread-${n}`,
    version: 4,
    readAt: "2026-11-01T00:00:00.000Z",
    kind: "newsletter",
    oneLine: "weekly notes",
    ask: "nothing — informational",
    owner: "nobody",
    entities: [],
    org: { unit: "marketing", confidence: 0.4 },
    importance: 0,
    disposition: "disposable",
  };
}

function digestItem(n: number): EmailItem {
  return {
    id: `digest-${n}`,
    threadId: `digest-thread-${n}`,
    fromEmail: `news${n}@lists.example`,
    fromName: `List ${n}`,
    subject: `Digest ${n}`,
    snippet: "nothing to do",
    receivedAt: "2026-11-01T00:00:00.000Z",
    isUnread: false,
  };
}

/** 46 conversations (2 cluster chunks of 45) and 61 disposable messages (2 digest chunks of 60). */
function wideInbox(): { items: EmailItem[]; understanding: Record<string, Understanding> } {
  const items = [
    ...Array.from({ length: 46 }, (_, n) => matterItem(n)),
    ...Array.from({ length: 61 }, (_, n) => digestItem(n)),
  ];
  const understanding: Record<string, Understanding> = {};
  for (let n = 0; n < 61; n += 1) understanding[`digest-${n}`] = disposableUnderstanding(n);
  return { items, understanding };
}

async function createMailbox(email: string) {
  const userId = await upsertUser(email);
  const accountId = await upsertAccount({
    userId,
    provider: "google",
    email,
    displayName: email,
  });
  await saveCredentials(accountId, "google", {
    accessToken: "placeholder-access-token",
    refreshToken: "placeholder-refresh-token",
    expiresAt: Date.now() + 60 * 60 * 1000,
  });
  return accountId;
}

function setLimits(fast: string, strong: string) {
  process.env.SEER_FAST_DAILY_CALL_LIMIT = fast;
  process.env.SEER_STRONG_DAILY_CALL_LIMIT = strong;
}

async function snapshotData(): Promise<Record<string, string>> {
  const names = await readdir(dataDir);
  const out: Record<string, string> = {};
  for (const name of names.sort()) {
    out[name] = await readFile(path.join(dataDir, name), "utf8");
  }
  return out;
}

async function usageCount(accountId: string): Promise<number> {
  const result = await db().query<{ n: number }>(
    `select count(*)::int as n from seer.model_usage where account_id = $1`,
    [accountId],
  );
  return result.rows[0]?.n ?? 0;
}

/**
 * Parallel budget reads that only SELECT count(*) see one shared snapshot.
 * A check that re-reads the same count and then calls the model still
 * overshoots. An insert that reserves the slot in the same statement does not.
 */
function stallBudgetSnapshots() {
  const pool = db();
  const original = pool.query.bind(pool);
  const pending: {
    args: Parameters<typeof pool.query>;
    resolve: (value: unknown) => void;
    reject: (error: unknown) => void;
  }[] = [];
  let timer: NodeJS.Timeout | undefined;
  const flush = async () => {
    const batch = pending.splice(0);
    if (batch.length === 0) return;
    try {
      const result = await original(...batch[0].args);
      for (const item of batch) item.resolve(result);
    } catch (error) {
      for (const item of batch) item.reject(error);
    }
  };
  pool.query = ((...args: Parameters<typeof pool.query>) => {
    const first = args[0] as { text?: string } | string;
    const sql = typeof first === "string" ? first : (first?.text ?? "");
    const snapshot =
      /^\s*select\s+count\(\*\)/i.test(sql) && /seer\.model_usage/i.test(sql);
    if (!snapshot) return original(...args);
    return new Promise((resolve, reject) => {
      pending.push({ args, resolve, reject });
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        void flush();
      }, 80);
    });
  }) as typeof pool.query;
  return () => {
    if (timer) clearTimeout(timer);
    pool.query = original;
    if (pending.length > 0) void flush();
  };
}

type Posted = {
  response: Response;
  finish: () => Promise<void>;
};

function invokePost(): Promise<Posted> {
  const tasks: Promise<unknown>[] = [];
  let notifyClose = () => {};
  const closed = new Promise<void>((resolve) => {
    notifyClose = resolve;
  });
  const afterContext = new AfterContext({
    waitUntil(task) {
      tasks.push(Promise.resolve(task));
    },
    onClose(done) {
      void closed.then(() => done());
    },
    onTaskError(error) {
      console.error(error);
    },
  });
  const store = {
    afterContext,
    route: "/api/brief",
    pendingRevalidatedTags: [] as string[],
    pendingRevalidates: {} as Record<string, Promise<unknown>>,
    pendingRevalidateWrites: [] as Promise<unknown>[],
  };
  return workAsyncStorage.run(store, async () => {
    const response = await POST();
    return {
      response,
      finish: () =>
        workAsyncStorage.run(store, async () => {
          notifyClose();
          await Promise.all(tasks);
        }),
    };
  });
}

async function signIn(email: string, accountId: string) {
  sessionEmail = email;
  activeAccountId = accountId;
}

const failures: string[] = [];
async function step(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    console.log("PASS", name);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    failures.push(`${name}: ${message.split("\n")[0]}`);
    console.error("FAIL", name);
    console.error(message);
  }
}

try {
  const exhausted = await createMailbox("exhausted@rditrials.com");
  const other = await createMailbox("other@rditrials.com");
  const atomic = await createMailbox("atomic@rditrials.com");
  const spender = await createMailbox("spender@rditrials.com");
  const routeA = await createMailbox("route-a@rditrials.com");
  const routeB = await createMailbox("route-b@rditrials.com");
  const routeC = await createMailbox("route-c@rditrials.com");
  const routeD = await createMailbox("route-d@rditrials.com");
  const { items, understanding } = wideInbox();
  let oneRebuildCalls = 0;
  let oneRebuildFetches = 0;

  await step("over-budget mailbox makes no model calls", async () => {
  calls.length = 0;
  setLimits("1", "1");
  delete process.env.SEER_DAILY_SPEND_LIMIT_USD;
  for (const tier of ["fast", "strong"] as const) {
    await recordModelUsage({
      accountId: exhausted,
      tier,
      model: "google/gemini-3-flash",
      escalationReasons: [],
      latencyMs: 1,
    });
  }
  await buildBrief("exhausted@rditrials.com", items, null, null, understanding);
  assert.equal(
    calls.length,
    0,
    "over-budget mailbox: cluster and digest model calls",
  );
  });

  await step("budget is per mailbox and one call stops the next rebuild", async () => {
  calls.length = 0;
  const beforeOther = await usageCount(other);
  await buildBrief("other@rditrials.com", items, null, null, understanding);
  assert.equal(
    calls.length,
    1,
    "one remaining call covers every parallel cluster and digest chunk",
  );
  assert.equal(
    await usageCount(exhausted),
    2,
    "exhausted mailbox must not gain usage rows from the other mailbox",
  );
  assert.ok(
    (await usageCount(other)) > beforeOther,
    "model calls are reserved against the mailbox that was rebuilt",
  );
  const otherCalls = calls.length;
  calls.length = 0;
  await buildBrief("other@rditrials.com", items, null, null, understanding);
  assert.equal(
    calls.length,
    0,
    `a limit of one call per tier stops a second rebuild; first rebuild made ${otherCalls}`,
  );
  });

  await step("parallel chunks cannot share a stale budget snapshot", async () => {
  calls.length = 0;
  setLimits("1", "1");
  const releaseStall = stallBudgetSnapshots();
  try {
    await buildBrief("atomic@rditrials.com", items, null, null, understanding);
  } finally {
    releaseStall();
  }
  assert.equal(
    calls.length,
    1,
    `parallel cluster and digest calls share one budget snapshot and must not each pass it; saw ${calls.length}`,
  );
  assert.equal(
    await usageCount(atomic),
    1,
    "the one allowed call is reserved to this mailbox before a second call starts",
  );
  calls.length = 0;
  await buildBrief("atomic@rditrials.com", items, null, null, understanding);
  assert.equal(calls.length, 0, "the reserved call is visible to the next rebuild");
  });

  await step("dollar cap stops the rebuild", async () => {
  calls.length = 0;
  setLimits("1000", "1000");
  process.env.SEER_DAILY_SPEND_LIMIT_USD = "0.01";
  await recordModelUsage({
    accountId: spender,
    tier: "fast",
    model: "google/gemini-3-flash",
    escalationReasons: [],
    latencyMs: 1,
    costUsd: 1,
  });
  await buildBrief("spender@rditrials.com", items, null, null, understanding);
  assert.equal(
    calls.length,
    0,
    "dollar cap in withinDailyBudget stops the rebuild while call count remains",
  );
  });

  delete process.env.SEER_DAILY_SPEND_LIMIT_USD;
  setLimits("1000", "1000");
  calls.length = 0;
  gmailFetches = 0;
  hold = null;
  inboxListGate = null;
  await step("accepted POST returns before the rebuild and then calls the model", async () => {
  await signIn("route-a@rditrials.com", routeA);
  const single = await invokePost();
  assert.equal(single.response.status, 200);
  assert.equal((await single.response.json()).building, true);
  const fetchesBeforeRebuild = gmailFetches;
  await single.finish();
  oneRebuildFetches = gmailFetches;
  oneRebuildCalls = calls.length;
  assert.ok(oneRebuildCalls >= 1, "an accepted rebuild calls the model after the response");
  assert.ok(fetchesBeforeRebuild >= 1, "the accepted rebuild reads the mailbox");
  });

  await step("a finished rebuild cannot be started again immediately", async () => {
  calls.length = 0;
  gmailFetches = 0;
  const filesBefore = await snapshotData();
  const again = await invokePost();
  assert.notEqual(
    again.response.status,
    200,
    "a mailbox cannot start another rebuild in the same minute",
  );
  assert.equal(again.response.status, 429);
  assert.equal(gmailFetches, 0, "the rejected rebuild fetches no mail");
  assert.equal(calls.length, 0, "the rejected rebuild calls no model");
  const filesAfter = await snapshotData();
  assert.deepEqual(
    filesAfter,
    filesBefore,
    "the rejected rebuild writes no stored brief or snapshot",
  );
  await again.finish();
  assert.equal(calls.length, 0, "rejection does not schedule a background rebuild");
  });

  await step("another mailbox is not blocked by an in-flight rebuild", async () => {
  calls.length = 0;
  gmailFetches = 0;
  let releaseHold: () => void = () => {};
  hold = new Promise<void>((resolve) => {
    releaseHold = resolve;
  });
  try {
  await signIn("route-c@rditrials.com", routeC);
  const inflight = await invokePost();
  assert.equal(inflight.response.status, 200);
  const finishing = inflight.finish();
  const entered = Date.now() + 2000;
  while (calls.length < 1 && Date.now() < entered) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.ok(calls.length >= 1, "first mailbox entered the model");
  const during = calls.length;
  await signIn("route-b@rditrials.com", routeB);
  const otherPost = await invokePost();
  assert.equal(
    otherPost.response.status,
    200,
    "a different mailbox is not blocked by the first mailbox's in-flight rebuild",
  );
  const finishingOther = otherPost.finish();
  const deadline = Date.now() + 2000;
  while (calls.length < during + 1 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  releaseHold();
  hold = null;
  await finishing;
  await finishingOther;
  assert.equal(
    JSON.stringify(calls[0]?.model),
    JSON.stringify(calls[during]?.model),
    "both mailboxes call the same deployment model",
  );
  assert.ok(
    calls.length >= during + 1,
    "the other mailbox's rebuild reaches the model",
  );
  } finally {
    releaseHold();
    hold = null;
  }
  });

  await step("overlapping posts for one mailbox schedule a single rebuild", async () => {
  calls.length = 0;
  gmailFetches = 0;
  await signIn("route-d@rditrials.com", routeD);
  const arrived: number[] = [];
  let releaseLists: () => void = () => {};
  const listsOpen = new Promise<void>((resolve) => {
    releaseLists = resolve;
  });
  inboxListGate = (n) => {
    arrived.push(n);
    return listsOpen;
  };
  const first = invokePost();
  const second = invokePost();
  try {
  const overlapDeadline = Date.now() + 2000;
  while (arrived.length < 1 && Date.now() < overlapDeadline) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  await new Promise((resolve) => setTimeout(resolve, 500));
  assert.equal(
    arrived.length,
    1,
    "a second POST for the same mailbox must not list that mailbox while a rebuild is already starting",
  );
  } finally {
    releaseLists();
    inboxListGate = null;
  }
  const [left, right] = await Promise.all([first, second]);
  const statuses = [left.response.status, right.response.status].sort();
  assert.deepEqual(statuses, [200, 429]);
  const accepted = left.response.status === 200 ? left : right;
  const rejected = left.response.status === 429 ? left : right;
  assert.equal((await accepted.response.json()).building, true);
  await rejected.finish();
  await accepted.finish();
  assert.equal(
    calls.length,
    oneRebuildCalls,
    "overlapping posts schedule one rebuild, not two",
  );
  assert.equal(
    gmailFetches,
    oneRebuildFetches,
    "overlapping posts fetch the mailbox once",
  );
  });

  if (failures.length > 0) {
    throw new Error(failures.join("\n"));
  }
  console.log("brief-rebuild-budget: OK");
} finally {
  globalThis.fetch = originalFetch;
  (Module as unknown as { _load: typeof originalLoad })._load = originalLoad;
  await database.stop();
  await rm(dataDir, { recursive: true, force: true });
}
