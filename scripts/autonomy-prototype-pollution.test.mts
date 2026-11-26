/**
 * Spec for the autonomy-ladder prototype pollution bug.
 *
 * These assertions describe the safe behavior. They fail while a caller-controlled
 * reason name is still written onto Object.prototype or the Object constructor.
 */
import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { encode } from "@auth/core/jwt";
import { startTestDb, type TestDb } from "./v2-testdb.mts";

// Next's request storage uses globalThis.AsyncLocalStorage, which Node does
// not install. Assign the real class before any Next module is evaluated.
const asyncHooksGlobal = globalThis as typeof globalThis & {
  AsyncLocalStorage?: typeof AsyncLocalStorage;
};
asyncHooksGlobal.AsyncLocalStorage = AsyncLocalStorage;

const AUTH_SECRET = "test-only-auth-secret";
const SESSION_COOKIE = "authjs.session-token";
const ORG_EMAIL = "attacker@rditrials.com";
const OUTSIDER_EMAIL = "outsider@example.com";
const PLACEHOLDER_ACCESS_TOKEN = "placeholder-access-token";
const MESSAGE_ID = "msg-own-1";
const THREAD_ID = "thr-own-1";

const INHERITED_NAMES = [
  "accepted",
  "reversed",
  "updatedAt",
  "recentAuto",
  "mode",
  "reason",
] as const;

process.env.AUTH_SECRET = AUTH_SECRET;
process.env.AUTH_URL = "http://127.0.0.1:3000";
delete process.env.AUTH_GOOGLE_ID;
delete process.env.AUTH_GOOGLE_SECRET;
delete process.env.UPSTASH_REDIS_REST_URL;
delete process.env.UPSTASH_REDIS_REST_TOKEN;
delete process.env.KV_REST_API_URL;
delete process.env.KV_REST_API_TOKEN;
delete process.env.SEER_V2_DATABASE_URL;
delete process.env.DATABASE_URL;
delete process.env.POSTGRES_PRISMA_URL;

const dataDir = await mkdtemp(path.join(tmpdir(), "seer-autonomy-"));
process.env.SEER_DATA_DIR = dataDir;

const db: TestDb = await startTestDb();
const poolOptions = db.pool.options as {
  host?: string;
  port?: number;
  user?: string;
  password?: string;
  database?: string;
};
process.env.POSTGRES_URL = `postgres://${encodeURIComponent(poolOptions.user ?? "")}:${encodeURIComponent(poolOptions.password ?? "")}@${poolOptions.host ?? "localhost"}:${poolOptions.port}/${poolOptions.database}`;

const { RequestCookies } = await import(
  "next/dist/server/web/spec-extension/cookies.js"
);
const { workAsyncStorage } = await import(
  "next/dist/server/app-render/work-async-storage.external.js"
);
const { workUnitAsyncStorage } = await import(
  "next/dist/server/app-render/work-unit-async-storage.external.js"
);
const { saveCredentials, upsertAccount, upsertUser } = await import(
  "../src/lib/v2/db/accounts.ts"
);
const {
  loadAutonomy,
  recordAccepted,
  recordAuto,
  recordReversal,
} = await import("../src/lib/store/autonomy.ts");
const { appendLedger } = await import("../src/lib/store/triage-ledger.ts");
const { saveBrief } = await import("../src/lib/inbox/matters.ts");
const { POST: bulkPost } = await import("../src/app/api/action/bulk/route.ts");
const { POST: clearPost } = await import("../src/app/api/triage/clear/route.ts");
const { POST: undoPost } = await import("../src/app/api/triage/undo/route.ts");

function scrubSharedObjects() {
  for (const name of INHERITED_NAMES) {
    delete (Object.prototype as Record<string, unknown>)[name];
    delete (Object as unknown as Record<string, unknown>)[name];
  }
}

function inheritedNames(value: object): string[] {
  const names: string[] = [];
  for (const key in value) names.push(key);
  return names.filter((key) =>
    (INHERITED_NAMES as readonly string[]).includes(key),
  );
}

const failures: string[] = [];

/** Pollution is the failure, whether or not the call also throws. */
async function assertNoSharedWrite(label: string, run: () => Promise<unknown>) {
  scrubSharedObjects();
  let outcome: unknown;
  try {
    outcome = await run();
  } catch (error) {
    outcome = error;
  }
  try {
    const problems: string[] = [];
    for (const name of INHERITED_NAMES) {
      if (Object.prototype.hasOwnProperty(name)) {
        const descriptor = Object.getOwnPropertyDescriptor(Object.prototype, name);
        problems.push(
          `Object.prototype.${name}=${String(descriptor?.value)} enumerable=${descriptor?.enumerable}`,
        );
      }
      if (Object.hasOwn(Object, name)) {
        problems.push(
          `Object.${name}=${String((Object as unknown as Record<string, unknown>)[name])}`,
        );
      }
    }
    const inherited = inheritedNames({});
    if (inherited.length > 0) {
      problems.push(`for-in on a fresh object sees ${inherited.join(",")}`);
    }
    if (outcome === Object.prototype) problems.push("returned Object.prototype");
    if (outcome === Object) problems.push("returned the Object constructor");
    assert.deepEqual(problems, [], `${label}: ${problems.join("; ")}`);
    if (outcome && typeof outcome === "object") {
      const response = outcome as { status?: number; json?: () => Promise<unknown> };
      if (typeof response.status === "number" && response.json) {
        // Route handlers may refuse the name or complete the mail action.
        // Either result is safe only when the shared objects stayed clean.
        await response.json().catch(() => undefined);
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    failures.push(message);
    console.error(`FAIL ${label}: ${message}`);
  } finally {
    scrubSharedObjects();
  }
}

function installFetchStub() {
  const calls: string[] = [];
  const previous = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url;
    const host = new URL(url).hostname;
    if (host !== "gmail.googleapis.com") {
      throw new Error(`refusing unexpected fetch to ${host}`);
    }
    calls.push(`${init?.method ?? "GET"} ${url}`);
    return new Response("", { status: 200 });
  }) as typeof fetch;
  return {
    calls,
    restore() {
      globalThis.fetch = previous;
    },
  };
}

async function sessionCookie(email: string): Promise<string> {
  const token = await encode({
    salt: SESSION_COOKIE,
    secret: AUTH_SECRET,
    token: { email, provider: "google" },
  });
  return `${SESSION_COOKIE}=${token}`;
}

function withRequest<T>(cookie: string, pathname: string, run: () => Promise<T>): Promise<T> {
  const headers = new Headers({
    cookie,
    host: "127.0.0.1:3000",
    "x-forwarded-proto": "http",
    "x-forwarded-host": "127.0.0.1:3000",
  });
  const workStore = {
    isStaticGeneration: false,
    page: pathname,
    route: pathname,
  };
  const requestStore = {
    type: "request" as const,
    phase: "render" as const,
    implicitTags: { tags: [], expirationsByCacheKind: new Map() },
    url: { pathname, search: "" },
    headers,
    cookies: new RequestCookies(headers),
    mutableCookies: {},
    userspaceMutableCookies: {},
    rootParams: {},
    renderResumeDataCache: null,
  };
  return workAsyncStorage.run(workStore, () =>
    workUnitAsyncStorage.run(requestStore, run),
  );
}

async function postJson(
  handler: (request: Request) => Promise<Response>,
  pathname: string,
  cookie: string,
  body: unknown,
): Promise<Response> {
  const request = new Request(`http://127.0.0.1:3000${pathname}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      cookie,
    },
    body: JSON.stringify(body),
  });
  return withRequest(cookie, pathname, () => handler(request));
}

function triageBrief() {
  return {
    builtAt: new Date().toISOString(),
    summary: "",
    matters: [],
    headlines: [],
    headlineIds: [{ id: MESSAGE_ID, threadId: THREAD_ID }],
    functions: [],
    totalInbox: 1,
    providerTotal: { messages: 1, threads: 1 },
    filed: [],
  };
}

async function ownCounter(email: string, reason: string, field: "accepted" | "reversed") {
  const store = await loadAutonomy(email);
  const policy = store.reasons[reason];
  assert.equal(Object.hasOwn(store.reasons, reason), true, `${reason} must be an own record`);
  assert.notStrictEqual(policy, Object.prototype);
  return policy[field];
}

const userId = await upsertUser(ORG_EMAIL);
const accountId = await upsertAccount({
  userId,
  provider: "google",
  email: ORG_EMAIL,
  displayName: "Attacker",
});
await saveCredentials(accountId, "google", {
  accessToken: PLACEHOLDER_ACCESS_TOKEN,
  expiresAt: Date.now() + 60 * 60 * 1000,
});

const orgCookie = await sessionCookie(ORG_EMAIL);
const outsiderCookie = await sessionCookie(OUTSIDER_EMAIL);
const fetchStub = installFetchStub();

try {
  // Fresh literal: loadAutonomy misses and builds { reasons: {} }.
  await assertNoSharedWrite("recordAccepted __proto__ on an empty store", async () =>
    recordAccepted("empty-literal@rditrials.com", "__proto__"),
  );

  // JSON-parsed document: a prior save is loaded back through Postgres jsonb,
  // which node-pg revives with JSON.parse (pg-types text parser for oid 3802).
  await recordAccepted("parsed-document@rditrials.com", "learned-sender");
  const parsedKey = "autonomy:parsed-document@rditrials.com";
  const stored = await db.pool.query("select value from seer_kv where key = $1", [
    parsedKey,
  ]);
  assert.equal(stored.rowCount, 1);
  assert.equal(typeof stored.rows[0].value, "object");
  await assertNoSharedWrite("recordAccepted __proto__ on a loaded document", async () =>
    recordAccepted("parsed-document@rditrials.com", "__proto__"),
  );

  await assertNoSharedWrite("recordAccepted constructor", async () =>
    recordAccepted("constructor-reason@rditrials.com", "constructor"),
  );
  await assertNoSharedWrite("recordReversal __proto__", async () =>
    recordReversal("reversal-proto@rditrials.com", "__proto__"),
  );
  await assertNoSharedWrite("recordReversal constructor", async () =>
    recordReversal("reversal-constructor@rditrials.com", "constructor"),
  );
  // recordAuto has no route caller; it shares ensure() with the routes above.
  await assertNoSharedWrite("recordAuto __proto__", async () =>
    recordAuto("auto-proto@rditrials.com", "__proto__"),
  );
  await assertNoSharedWrite("recordAuto constructor", async () =>
    recordAuto("auto-constructor@rditrials.com", "constructor"),
  );

  const benign = await recordAccepted(ORG_EMAIL, "learned-sender");
  assert.equal(benign.accepted, 1);
  assert.equal(benign.reason, "learned-sender");
  assert.equal(await ownCounter(ORG_EMAIL, "learned-sender", "accepted"), 1);
  assert.deepEqual(inheritedNames({}), []);

  // Unsigned request never reaches the store. headers() still needs a request store.
  scrubSharedObjects();
  const anonymous = await postJson(bulkPost, "/api/action/bulk", "", {
    items: [{ id: MESSAGE_ID, action: "read" }],
    reason: "__proto__",
    source: "confirmed",
  });
  assert.equal(anonymous.status, 401);
  assert.equal(Object.prototype.hasOwnProperty("accepted"), false);

  const outsider = await postJson(bulkPost, "/api/action/bulk", outsiderCookie, {
    items: [{ id: MESSAGE_ID, action: "read" }],
    reason: "__proto__",
    source: "confirmed",
  });
  assert.equal(outsider.status, 401);
  assert.equal(Object.prototype.hasOwnProperty("accepted"), false);

  const beforeAccepted = await ownCounter(ORG_EMAIL, "learned-sender", "accepted");
  const benignBulk = await postJson(bulkPost, "/api/action/bulk", orgCookie, {
    items: [{ id: MESSAGE_ID, action: "read" }],
    reason: "learned-sender",
    source: "confirmed",
  });
  const benignBulkBody = (await benignBulk.json()) as { processed?: number; error?: string };
  assert.equal(benignBulk.status, 200, JSON.stringify(benignBulkBody));
  assert.equal(benignBulkBody.processed, 1);
  assert.ok(
    fetchStub.calls.some((call) =>
      call.includes(`/users/me/messages/${MESSAGE_ID}/modify`),
    ),
    `gmail modify was not called: ${fetchStub.calls.join(" | ")}`,
  );
  assert.equal(
    await ownCounter(ORG_EMAIL, "learned-sender", "accepted"),
    beforeAccepted + 1,
  );

  await assertNoSharedWrite("POST /api/action/bulk reason __proto__", async () =>
    postJson(bulkPost, "/api/action/bulk", orgCookie, {
      items: [{ id: MESSAGE_ID, action: "read" }],
      reason: "__proto__",
      source: "confirmed",
    }),
  );
  await assertNoSharedWrite("POST /api/action/bulk reason __proto__ with source omitted", async () =>
    postJson(bulkPost, "/api/action/bulk", orgCookie, {
      items: [{ id: MESSAGE_ID, action: "read" }],
      reason: "__proto__",
    }),
  );
  await assertNoSharedWrite("POST /api/action/bulk reason constructor", async () =>
    postJson(bulkPost, "/api/action/bulk", orgCookie, {
      items: [{ id: MESSAGE_ID, action: "read" }],
      reason: "constructor",
      source: "confirmed",
    }),
  );

  const acceptedBeforeAuto = await ownCounter(ORG_EMAIL, "learned-sender", "accepted");
  const autoSweep = await postJson(bulkPost, "/api/action/bulk", orgCookie, {
    items: [{ id: MESSAGE_ID, action: "read" }],
    reason: "learned-sender",
    source: "auto",
  });
  assert.equal(autoSweep.status, 200);
  assert.equal(
    await ownCounter(ORG_EMAIL, "learned-sender", "accepted"),
    acceptedBeforeAuto,
  );
  await assertNoSharedWrite("POST /api/action/bulk source auto reason __proto__", async () =>
    postJson(bulkPost, "/api/action/bulk", orgCookie, {
      items: [{ id: MESSAGE_ID, action: "read" }],
      reason: "__proto__",
      source: "auto",
    }),
  );

  await saveBrief(ORG_EMAIL, triageBrief() as never);
  const acceptedBeforeClear = await ownCounter(ORG_EMAIL, "learned-sender", "accepted");
  const benignClear = await postJson(clearPost, "/api/triage/clear", orgCookie, {
    rows: [{ id: MESSAGE_ID, threadId: THREAD_ID }],
    reason: "learned-sender",
    mode: "archive",
  });
  const benignClearBody = (await benignClear.json()) as { processed?: number; error?: string };
  assert.equal(benignClear.status, 200, JSON.stringify(benignClearBody));
  assert.equal(benignClearBody.processed, 1);
  assert.ok(
    fetchStub.calls.some((call) =>
      call.includes(`/users/me/threads/${THREAD_ID}/modify`),
    ),
  );
  assert.equal(
    await ownCounter(ORG_EMAIL, "learned-sender", "accepted"),
    acceptedBeforeClear + 1,
  );
  await saveBrief(ORG_EMAIL, triageBrief() as never);
  await assertNoSharedWrite("POST /api/triage/clear reason __proto__", async () =>
    postJson(clearPost, "/api/triage/clear", orgCookie, {
      rows: [{ id: MESSAGE_ID, threadId: THREAD_ID }],
      reason: "__proto__",
    }),
  );
  await saveBrief(ORG_EMAIL, triageBrief() as never);
  await assertNoSharedWrite("POST /api/triage/clear reason constructor", async () =>
    postJson(clearPost, "/api/triage/clear", orgCookie, {
      rows: [{ id: MESSAGE_ID, threadId: THREAD_ID }],
      reason: "constructor",
    }),
  );

  const benignEntry = await appendLedger(ORG_EMAIL, {
    kind: "sweep",
    summary: "benign",
    reason: "learned-sender",
    source: "confirmed",
    emailIds: [MESSAGE_ID],
  });
  const reversedBefore = (await loadAutonomy(ORG_EMAIL)).reasons["learned-sender"]?.reversed ?? 0;
  const benignUndo = await postJson(undoPost, "/api/triage/undo", orgCookie, {
    entryId: benignEntry.id,
  });
  const benignUndoBody = (await benignUndo.json()) as { ok?: boolean; error?: string };
  assert.equal(benignUndo.status, 200, JSON.stringify(benignUndoBody));
  assert.equal(benignUndoBody.ok, true);
  assert.equal(
    await ownCounter(ORG_EMAIL, "learned-sender", "reversed"),
    reversedBefore + 1,
  );
  assert.ok(
    fetchStub.calls.some((call) => call.includes("addLabelIds") || call.includes("/modify")),
  );

  const protoEntry = await appendLedger(ORG_EMAIL, {
    kind: "sweep",
    summary: "poison",
    reason: "__proto__",
    source: "confirmed",
    emailIds: [MESSAGE_ID],
  });
  await assertNoSharedWrite("POST /api/triage/undo stored reason __proto__", async () =>
    postJson(undoPost, "/api/triage/undo", orgCookie, { entryId: protoEntry.id }),
  );
  const constructorEntry = await appendLedger(ORG_EMAIL, {
    kind: "sweep",
    summary: "poison constructor",
    reason: "constructor",
    source: "confirmed",
    emailIds: [MESSAGE_ID],
  });
  await assertNoSharedWrite("POST /api/triage/undo stored reason constructor", async () =>
    postJson(undoPost, "/api/triage/undo", orgCookie, {
      entryId: constructorEntry.id,
    }),
  );

  if (failures.length > 0) {
    throw new Error(
      `${failures.length} prototype-pollution check(s) failed:\n\n${failures.join("\n\n")}`,
    );
  }
  console.log("autonomy-prototype-pollution: OK");
} finally {
  scrubSharedObjects();
  fetchStub.restore();
  await db.stop();
  await rm(dataDir, { recursive: true, force: true });
}
