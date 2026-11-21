/**
 * Spec for the waiting-queue cache-busting GET.
 *
 * A signed-in browser sends the Auth.js session cookie on a cross-site
 * top-level navigation because that cookie is SameSite=Lax. Chrome 157 on
 * HTTPS sends that navigation with no Origin header, Sec-Fetch-Site:
 * cross-site, Sec-Fetch-Mode: navigate, and Sec-Fetch-Dest: document.
 * `GET /api/waiting?fresh=1` must ignore the fresh flag for that request:
 * it must not read Gmail with the mailbox token and must not replace the
 * cached queue. The next in-app load (no fresh flag) must still show the
 * queue that was cached before the navigation.
 *
 * A request whose Origin is the application origin may still rescan.
 * These assertions fail until that gate exists.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { mock } from "node:test";

const APP_ORIGIN = "https://seer.example";
const VICTIM = "victim@rditrials.com";
const MAILBOX_TOKEN = "placeholder-mailbox-access-token";
const AUTH_SECRET = "placeholder-auth-secret";

process.env.AUTH_SECRET = AUTH_SECRET;
process.env.AUTH_URL = APP_ORIGIN;
process.env.NODE_ENV = "test";
delete process.env.SEER_ALLOWED_ORIGIN;
delete process.env.SEER_V3_LEGACY_ACCOUNT_FALLBACK;
delete process.env.SEER_V2_DATABASE_URL;
delete process.env.POSTGRES_URL;
delete process.env.POSTGRES_PRISMA_URL;
delete process.env.DATABASE_URL;
delete process.env.UPSTASH_REDIS_REST_URL;
delete process.env.UPSTASH_REDIS_REST_TOKEN;
delete process.env.KV_REST_API_URL;
delete process.env.KV_REST_API_TOKEN;

const dataDir = await mkdtemp(path.join(os.tmpdir(), "waiting-fresh-csrf-"));
process.env.SEER_DATA_DIR = dataDir;

let currentHeaders = new Headers();

mock.module("next/headers", {
  namedExports: {
    headers: async () => currentHeaders,
    cookies: async () => cookieJar(currentHeaders.get("cookie") ?? ""),
  },
});

const { encode } = await import("@auth/core/jwt");
const { defaultCookies } = await import(
  "../node_modules/@auth/core/lib/utils/cookie.js"
);
const { startTestDb } = await import("./v2-testdb.mts");
const accounts = await import("../src/lib/v2/db/accounts.ts");
const kv = await import("../src/lib/store/kv.ts");
const { ACTIVE_ACCOUNT_COOKIE } = await import("../src/lib/store/accounts.ts");
const { GET } = await import("../src/app/api/waiting/route.ts");

const sessionCookie = defaultCookies(true).sessionToken;
assert.equal(
  sessionCookie.options.sameSite,
  "lax",
  "Auth.js session cookie must be the SameSite=Lax cookie a cross-site navigation sends",
);
assert.equal(sessionCookie.options.secure, true);
assert.equal(sessionCookie.name, "__Secure-authjs.session-token");

type GmailCall = { url: string; authorization: string | null };
const gmailCalls: GmailCall[] = [];

const sentAt = new Date(Date.now() - 5 * 86_400_000).toISOString();
const internalDate = String(new Date(sentAt).getTime());
const THREADS = Array.from({ length: 20 }, (_, i) => ({
  id: `msg-${i + 1}`,
  threadId: `thread-${i + 1}`,
  to: `pat${i + 1}@example.com`,
  subject: `Need a reply ${i + 1}`,
}));

const originalQueue = [
  {
    threadId: "cached-thread",
    messageId: "cached-message",
    to: "kept@example.com",
    toName: "Kept",
    subject: "Cached follow-up",
    sentAt,
    daysWaiting: 5,
  },
];

const realFetch = globalThis.fetch.bind(globalThis);
globalThis.fetch = async (input, init) => {
  const url =
    typeof input === "string"
      ? input
      : input instanceof URL
        ? input.toString()
        : input.url;
  if (!url.startsWith("https://gmail.googleapis.com/")) {
    return realFetch(input, init);
  }
  const headers = new Headers(
    init?.headers ?? (input instanceof Request ? input.headers : undefined),
  );
  gmailCalls.push({ url, authorization: headers.get("authorization") });
  return gmailResponse(url);
};

const db = await startTestDb();
try {
  const userId = await accounts.upsertUser(VICTIM);
  const account = await accounts.upsertAccountWithCredentials({
    userId,
    provider: "google",
    email: VICTIM,
    displayName: "Victim",
    accessToken: MAILBOX_TOKEN,
    expiresAt: Date.now() + 3_600_000,
  });
  const sessionToken = await encode({
    token: {
      email: VICTIM,
      sub: userId,
      name: "Victim",
      provider: "google",
    },
    secret: AUTH_SECRET,
    salt: sessionCookie.name,
  });
  const signedInCookie = [
    `${sessionCookie.name}=${sessionToken}`,
    `${ACTIVE_ACCOUNT_COOKIE}=${account.id}`,
  ].join("; ");

  await seedQueue();

  gmailCalls.length = 0;
  const anonymous = await call(
    requestFor(`${APP_ORIGIN}/api/waiting?fresh=1`, {
      origin: "https://attacker.example",
      secFetchSite: "cross-site",
      secFetchMode: "navigate",
      secFetchDest: "document",
      referer: "https://attacker.example/lure",
    }),
  );
  assert.equal(anonymous.status, 401);
  assert.equal(gmailCalls.length, 0, "an anonymous request must not read Gmail");
  assert.deepEqual((await loadQueue())?.items, originalQueue);

  gmailCalls.length = 0;
  const warm = await call(
    requestFor(`${APP_ORIGIN}/api/waiting`, {
      cookie: signedInCookie,
      secFetchSite: "cross-site",
      secFetchMode: "navigate",
      secFetchDest: "document",
      referer: "https://attacker.example/lure",
    }),
  );
  assert.equal(warm.status, 200);
  assert.equal(warm.body.cached, true);
  assert.equal(
    gmailCalls.length,
    0,
    "a warm cache already absorbs a cross-site navigation that does not pass fresh",
  );

  await assertCacheHeld(crossSiteNavigation(signedInCookie), "cross-site navigation");
  await assertCacheHeld(
    crossSiteNavigation(signedInCookie, {
      origin: "https://attacker.example",
    }),
    "cross-site navigation with an attacker Origin",
  );
  await assertCacheHeld(
    crossSiteNavigation(signedInCookie, {
      secFetchSite: null,
      secFetchMode: null,
      secFetchDest: null,
    }),
    "cross-site navigation that omits Fetch Metadata",
  );
  for (const origin of [
    "https://seer.example.evil.test",
    "http://seer.example",
    "https://seer.example:444",
    "null",
  ]) {
    await assertCacheHeld(
      crossSiteNavigation(signedInCookie, { origin }),
      `fresh=1 with Origin ${origin}`,
    );
  }

  gmailCalls.length = 0;
  const rescanned = await call(
    requestFor(`${APP_ORIGIN}/api/waiting?fresh=1`, {
      cookie: signedInCookie,
      origin: APP_ORIGIN,
      secFetchSite: "same-origin",
      secFetchMode: "cors",
      secFetchDest: "empty",
    }),
  );
  assert.equal(rescanned.status, 200);
  assert.equal(rescanned.body.cached, undefined);
  assert.equal(rescanned.body.items.length, THREADS.length);
  const listCalls = gmailCalls.filter((call) =>
    call.url.includes("/users/me/messages?"),
  );
  const threadCalls = gmailCalls.filter((call) =>
    call.url.includes("/users/me/threads/"),
  );
  assert.equal(listCalls.length, 1, "a same-origin rescan lists sent mail");
  assert.match(listCalls[0].url, /maxResults=60/);
  assert.match(listCalls[0].url, /in(?:%3A|:)sent/);
  assert.equal(threadCalls.length, 20, "a same-origin rescan reads 20 threads");
  assert.ok(
    gmailCalls.every((call) => call.authorization === `Bearer ${MAILBOX_TOKEN}`),
    "the rescan uses the signed-in mailbox token",
  );
  const replaced = await loadQueue();
  assert.equal(replaced?.items.length, 20);
  assert.notEqual(replaced?.items[0]?.threadId, "cached-thread");

  console.log("waiting-fresh-csrf: OK");
} finally {
  globalThis.fetch = realFetch;
  await db.stop();
  await rm(dataDir, { recursive: true, force: true });
}

async function assertCacheHeld(
  request: Request,
  label: string,
): Promise<void> {
  await seedQueue();
  const before = await loadQueue();
  gmailCalls.length = 0;
  const result = await call(request);
  assert.equal(result.status, 200, `${label} is authenticated by the session cookie`);
  assert.equal(
    gmailCalls.length,
    0,
    `${label} must not read Gmail when fresh=1 is set`,
  );
  assert.deepEqual(result.body.items, originalQueue, `${label} must return the existing queue`);
  assert.equal(result.body.cached, true, `${label} must stay on the cache`);
  const after = await loadQueue();
  assert.deepEqual(after, before, `${label} must not replace the stored queue`);

  gmailCalls.length = 0;
  const nextLoad = await call(
    requestFor(`${APP_ORIGIN}/api/waiting`, {
      cookie: request.headers.get("cookie") ?? "",
      origin: APP_ORIGIN,
      secFetchSite: "same-origin",
      secFetchMode: "cors",
      secFetchDest: "empty",
    }),
  );
  assert.equal(nextLoad.status, 200);
  assert.deepEqual(
    nextLoad.body.items,
    originalQueue,
    `${label} must not change what the next in-app load shows`,
  );
  assert.equal(
    gmailCalls.length,
    0,
    "the follow-up in-app load reads the cache the navigation left in place",
  );
}

function crossSiteNavigation(
  cookie: string,
  extra: {
    origin?: string | null;
    secFetchSite?: string | null;
    secFetchMode?: string | null;
    secFetchDest?: string | null;
  } = {},
): Request {
  return requestFor(`${APP_ORIGIN}/api/waiting?fresh=1`, {
    cookie,
    origin: extra.origin === undefined ? null : extra.origin,
    secFetchSite:
      extra.secFetchSite === undefined ? "cross-site" : extra.secFetchSite,
    secFetchMode:
      extra.secFetchMode === undefined ? "navigate" : extra.secFetchMode,
    secFetchDest:
      extra.secFetchDest === undefined ? "document" : extra.secFetchDest,
    referer: "https://attacker.example/lure",
  });
}

function requestFor(
  url: string,
  headers: {
    cookie?: string;
    origin?: string | null;
    secFetchSite?: string | null;
    secFetchMode?: string | null;
    secFetchDest?: string | null;
    referer?: string | null;
  },
): Request {
  const requestHeaders = new Headers();
  if (headers.cookie) requestHeaders.set("cookie", headers.cookie);
  if (headers.origin) requestHeaders.set("origin", headers.origin);
  if (headers.secFetchSite) {
    requestHeaders.set("sec-fetch-site", headers.secFetchSite);
  }
  if (headers.secFetchMode) {
    requestHeaders.set("sec-fetch-mode", headers.secFetchMode);
  }
  if (headers.secFetchDest) {
    requestHeaders.set("sec-fetch-dest", headers.secFetchDest);
  }
  if (headers.referer) requestHeaders.set("referer", headers.referer);
  requestHeaders.set("host", "seer.example");
  requestHeaders.set("x-forwarded-proto", "https");
  return new Request(url, { method: "GET", headers: requestHeaders });
}

async function call(request: Request): Promise<{
  status: number;
  body: { items?: typeof originalQueue; cached?: boolean; error?: string };
}> {
  currentHeaders = new Headers(request.headers);
  const response = await GET(request);
  const body = (await response.json()) as {
    items?: typeof originalQueue;
    cached?: boolean;
    error?: string;
  };
  return { status: response.status, body };
}

async function seedQueue(): Promise<void> {
  await kv.kvSet(`waiting:${VICTIM}`, {
    builtAt: new Date().toISOString(),
    items: originalQueue,
  });
}

async function loadQueue(): Promise<{
  builtAt: string;
  items: typeof originalQueue;
} | null> {
  return kv.kvGet(`waiting:${VICTIM}`);
}

function gmailResponse(url: string): Response {
  const parsed = new URL(url);
  if (parsed.pathname.endsWith("/users/me/messages")) {
    return Response.json({
      messages: THREADS.map((thread) => ({
        id: thread.id,
        threadId: thread.threadId,
      })),
    });
  }
  const message = parsed.pathname.match(/\/users\/me\/messages\/([^/]+)$/);
  if (message) {
    const thread = THREADS.find((item) => item.id === decodeURIComponent(message[1]));
    if (!thread) return new Response("missing", { status: 404 });
    return Response.json({
      id: thread.id,
      threadId: thread.threadId,
      internalDate,
      labelIds: ["SENT"],
      payload: {
        headers: [
          { name: "From", value: `Victim <${VICTIM}>` },
          { name: "To", value: `Pat <${thread.to}>` },
          { name: "Subject", value: thread.subject },
        ],
      },
    });
  }
  const threadMatch = parsed.pathname.match(/\/users\/me\/threads\/([^/]+)$/);
  if (threadMatch) {
    const thread = THREADS.find(
      (item) => item.threadId === decodeURIComponent(threadMatch[1]),
    );
    if (!thread) return new Response("missing", { status: 404 });
    return Response.json({
      messages: [
        {
          id: thread.id,
          internalDate,
          payload: {
            headers: [{ name: "From", value: `Victim <${VICTIM}>` }],
          },
        },
      ],
    });
  }
  return new Response("unexpected gmail url", { status: 500 });
}

function cookieJar(raw: string) {
  const values = new Map<string, string>();
  for (const part of raw.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 0) continue;
    values.set(part.slice(0, separator).trim(), part.slice(separator + 1).trim());
  }
  return {
    get(name: string) {
      const value = values.get(name);
      return value === undefined ? undefined : { name, value };
    },
    getAll() {
      return [...values.entries()].map(([name, value]) => ({ name, value }));
    },
    has(name: string) {
      return values.has(name);
    },
    set() {
      throw new Error("this test does not expect the handler to set cookies");
    },
    delete() {},
  };
}
