/**
 * Cross-site navigation must not spend a signed-in mailbox's provider quota.
 *
 * These tests fail while GET /api/classifier/samples (and the other
 * session-only GETs that share that behavior) list or rebuild mail from
 * Gmail or Microsoft Graph before checking Origin. They pass once a
 * navigation is refused before any provider call or mail-history write.
 *
 * A same-origin browser fetch, or a same-origin POST, may still export.
 */
import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";
import { encode } from "@auth/core/jwt";
import { startTestDb, type TestDb } from "./v2-testdb.mts";

// Next's request storage uses globalThis.AsyncLocalStorage, which the Node
// server sets in next/dist/server/node-environment-baseline.js before any
// route module loads. This process is not `next start`, so do that first.
if (typeof globalThis.AsyncLocalStorage !== "function") {
  globalThis.AsyncLocalStorage = AsyncLocalStorage;
}

const SITE = "https://seer.example";
const ATTACKER = "https://attacker.example";
const VICTIM = "victim@rditrials.com";
const ACCESS_TOKEN = "placeholder-mailbox-access-token";
const AUTH_SECRET = "test-auth-secret-placeholder";

process.env.NODE_ENV = "production";
process.env.AUTH_SECRET = AUTH_SECRET;
process.env.AUTH_URL = SITE;
process.env.AUTH_TRUST_HOST = "true";
process.env.SEER_CREDENTIAL_KEY = Buffer.alloc(32, 7).toString("base64");
process.env.GEMINI_API_KEY = "placeholder-gemini-key";
delete process.env.SEER_V2_DATABASE_URL;
delete process.env.POSTGRES_URL;
delete process.env.POSTGRES_PRISMA_URL;
delete process.env.DATABASE_URL;
delete process.env.UPSTASH_REDIS_REST_URL;
delete process.env.UPSTASH_REDIS_REST_TOKEN;
delete process.env.KV_REST_API_URL;
delete process.env.KV_REST_API_TOKEN;
delete process.env.SEER_ALLOWED_ORIGIN;
delete process.env.VERCEL;
delete process.env.VERCEL_OIDC_TOKEN;

type FetchCall = { url: string; authorization: string | null };
const providerCalls: FetchCall[] = [];
const originalFetch = globalThis.fetch;

function providerHost(url: string): boolean {
  const host = new URL(url).hostname;
  return (
    host === "gmail.googleapis.com" ||
    host === "graph.microsoft.com" ||
    host === "people.googleapis.com" ||
    host === "www.googleapis.com" ||
    host === "oauth2.googleapis.com" ||
    host === "login.microsoftonline.com"
  );
}

globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
  const url =
    typeof input === "string"
      ? input
      : input instanceof URL
        ? input.toString()
        : input.url;
  const headers = new Headers(
    init?.headers ?? (input instanceof Request ? input.headers : undefined),
  );
  if (providerHost(url)) {
    providerCalls.push({
      url,
      authorization: headers.get("authorization"),
    });
  }
  const parsed = new URL(url);
  if (parsed.hostname === "gmail.googleapis.com") {
    if (parsed.pathname.includes("/messages")) {
      return Response.json({ messages: [] });
    }
    return Response.json({ labels: [] });
  }
  if (parsed.hostname === "graph.microsoft.com") {
    return Response.json({ value: [] });
  }
  if (parsed.hostname === "people.googleapis.com") {
    return Response.json({ connections: [], otherContacts: [] });
  }
  if (parsed.hostname === "www.googleapis.com") {
    return Response.json({ items: [] });
  }
  return new Response("stub refused an unexpected host", { status: 599 });
};

// Auth.js secure session cookie. @auth/core 0.41.3 defaultCookies(true).sessionToken.name
const sessionCookie = { name: "__Secure-authjs.session-token" };

async function sessionCookieHeader(
  provider: "google" | "microsoft-entra-id",
  activeAccountId: string,
): Promise<string> {
  const jwt = await encode({
    token: {
      email: VICTIM,
      provider,
      activeAccountId,
      sub: VICTIM,
    },
    secret: AUTH_SECRET,
    salt: sessionCookie.name,
  });
  return `${sessionCookie.name}=${jwt}; seer_active_account=${activeAccountId}`;
}

function requestFor(
  pathname: string,
  cookie: string,
  origin: string | null,
  method = "GET",
): Request {
  const headers = new Headers({
    cookie,
    host: "seer.example",
    "x-forwarded-proto": "https",
    "x-forwarded-host": "seer.example",
    "sec-fetch-site": origin === SITE ? "same-origin" : "cross-site",
    "sec-fetch-mode": origin === SITE ? "cors" : "navigate",
    "sec-fetch-dest": origin === SITE ? "empty" : "document",
  });
  if (origin !== null) headers.set("origin", origin);
  return new Request(`${SITE}${pathname}`, { method, headers });
}

const { createRequestStoreForAPI } = await import(
  "next/dist/server/async-storage/request-store.js"
);
const { workAsyncStorage } = await import(
  "next/dist/server/app-render/work-async-storage.external.js"
);
const { workUnitAsyncStorage } = await import(
  "next/dist/server/app-render/work-unit-async-storage.external.js"
);

type RouteHandler = (
  request: Request,
  context?: { params: Promise<{ id: string }> },
) => Promise<Response>;

async function callIfPresent(
  handler: RouteHandler | undefined,
  request: Request,
  context?: { params: Promise<{ id: string }> },
): Promise<Response> {
  if (typeof handler !== "function") {
    return new Response(null, { status: 405 });
  }
  return callRoute(handler, request, context);
}

async function callRoute(
  handler: (request: Request, context?: { params: Promise<{ id: string }> }) => Promise<Response>,
  request: Request,
  context?: { params: Promise<{ id: string }> },
): Promise<Response> {
  const headers: Record<string, string> = {};
  request.headers.forEach((value, key) => {
    headers[key] = value;
  });
  const url = new URL(request.url);
  const requestStore = createRequestStoreForAPI(
    { headers, url: `${url.pathname}${url.search}` },
    url,
    [],
    () => {},
    {
      previewModeId: "test-preview",
      previewModeEncryptionKey: "test-preview-encryption",
      previewModeSigningKey: "test-preview-signing",
    },
  );
  const workStore = {
    route: url.pathname,
    forceStatic: false,
    dynamicShouldError: false,
  };
  return workAsyncStorage.run(workStore, () =>
    workUnitAsyncStorage.run(requestStore, () => handler(request, context)),
  );
}

function resetCalls() {
  providerCalls.length = 0;
}

let db: TestDb;
let googleAccountId = "";
let microsoftAccountId = "";
let googleCookie = "";
let microsoftCookie = "";

const dbHandle = await startTestDb();
db = dbHandle;
const port = Number(
  (await db.pool.query<{ port: string }>("select inet_server_port()::text as port")).rows[0]
    .port,
);
await db.pool.query("alter role seer_app with password 'test-only-db-password'");
process.env.SEER_V2_DATABASE_URL = `postgres://seer_app:test-only-db-password@127.0.0.1:${port}/seer_test`;

const accounts = await import("../src/lib/v2/db/accounts.ts");
const historyStore = await import("../src/lib/inbox/mail-history-store.ts");
const samplesRoute = await import("../src/app/api/classifier/samples/route.ts");
const alltasksRoute = await import("../src/app/api/alltasks/route.ts");
const unsubRoute = await import("../src/app/api/unsub-agent/route.ts");
const todayRoute = await import("../src/app/api/today/route.ts");
const mailboxRoute = await import("../src/app/api/mailbox/route.ts");
const catchupRoute = await import("../src/app/api/catchup/route.ts");
const contactsRoute = await import("../src/app/api/contacts/route.ts");
const vipsRoute = await import("../src/app/api/vips/route.ts");
const waitingRoute = await import("../src/app/api/waiting/route.ts");
const messageRoute = await import("../src/app/api/messages/[id]/route.ts");
const attachmentRoute = await import(
  "../src/app/api/messages/[id]/attachment/route.ts"
);
const lastOpen = await import("../src/lib/store/last-open.ts");
const kv = await import("../src/lib/store/kv.ts");

async function forgetProviderCaches() {
  const key = kv.accountKey(VICTIM);
  for (const prefix of [
    "mail-history",
    "kept-scan",
    "inbox-snap",
    "waiting",
    "gmail-labels",
    "personal",
  ]) {
    await kv.kvDelete(`${prefix}:${key}`);
  }
}

try {
  const userId = await accounts.upsertUser(VICTIM);
  const expiresAt = Date.now() + 86_400_000;
  const google = await accounts.upsertAccountWithCredentials({
    userId,
    provider: "google",
    email: VICTIM,
    displayName: "Victim",
    accessToken: ACCESS_TOKEN,
    expiresAt,
  });
  const microsoft = await accounts.upsertAccountWithCredentials({
    userId,
    provider: "microsoft",
    email: VICTIM,
    displayName: "Victim",
    accessToken: ACCESS_TOKEN,
    expiresAt,
  });
  googleAccountId = google.id;
  microsoftAccountId = microsoft.id;
  googleCookie = await sessionCookieHeader("google", google.id);
  microsoftCookie = await sessionCookieHeader("microsoft-entra-id", microsoft.id);

  await historyStore.saveCachedHistory({
    accountEmail: VICTIM,
    builtAt: new Date().toISOString(),
    contacts: {},
    engagedCount: 0,
    contactCount: 0,
  });
  const warm = await historyStore.loadCachedHistory(VICTIM);
  assert.ok(warm, "history cache must be warm before the export");
  const warmBuiltAt = warm.builtAt;

  resetCalls();
  let allowed = await callIfPresent(
    samplesRoute.GET,
    requestFor("/api/classifier/samples", googleCookie, SITE),
  );
  if (allowed.status === 405) {
    resetCalls();
    allowed = await callIfPresent(
      samplesRoute.POST,
      requestFor("/api/classifier/samples", googleCookie, SITE, "POST"),
    );
  }
  assert.equal(allowed.status, 200, "same-origin export stays available");
  const allowedBody = await allowed.json();
  assert.equal(allowedBody.accountEmail, VICTIM);
  assert.equal(allowedBody.provider, "google");
  assert.ok(Array.isArray(allowedBody.samples));
  const allowedInbox = providerCalls.filter((call) =>
    call.url.includes("gmail.googleapis.com") && call.url.includes("in%3Ainbox"),
  );
  assert.equal(
    allowedInbox.length,
    1,
    "a same-origin export lists the inbox once",
  );
  assert.equal(allowedInbox[0]?.authorization, `Bearer ${ACCESS_TOKEN}`);
  assert.ok(
    allowedInbox[0]?.url.includes("maxResults=60"),
    "the export asks Gmail for up to 60 inbox messages",
  );
  assert.equal(
    providerCalls.filter((call) => call.url.includes("in%3Asent")).length,
    0,
    "a warm history cache must not scan sent mail again",
  );
  assert.equal(
    (await historyStore.loadCachedHistory(VICTIM))?.builtAt,
    warmBuiltAt,
    "the warm history entry is reused",
  );

  const failures: string[] = [];

  async function assertNavigationRefused(
    label: string,
    cookie: string,
    pathname: string,
    origin: string | null,
    invoke: (request: Request) => Promise<Response>,
  ) {
    const before = (await historyStore.loadCachedHistory(VICTIM))?.builtAt ?? null;
    resetCalls();
    const response = await invoke(requestFor(pathname, cookie, origin));
    await response.text();
    const problems: string[] = [];
    if (response.status !== 403 && response.status !== 405) {
      problems.push(`status ${response.status}`);
    }
    if (providerCalls.length !== 0) {
      problems.push(
        `provider calls: ${providerCalls.map((call) => new URL(call.url).pathname).join(" ")}`,
      );
    }
    const after = (await historyStore.loadCachedHistory(VICTIM))?.builtAt ?? null;
    if (after !== before) problems.push("mail-history cache was written");
    if (problems.length) failures.push(`${label}: ${problems.join("; ")}`);
  }

  await assertNavigationRefused(
    "classifier export with a foreign Origin",
    googleCookie,
    "/api/classifier/samples",
    ATTACKER,
    (request) => callIfPresent(samplesRoute.GET, request),
  );
  await assertNavigationRefused(
    "classifier export with no Origin",
    googleCookie,
    "/api/classifier/samples",
    null,
    (request) => callIfPresent(samplesRoute.GET, request),
  );
  await assertNavigationRefused(
    "classifier export with Origin null",
    googleCookie,
    "/api/classifier/samples",
    "null",
    (request) => callIfPresent(samplesRoute.GET, request),
  );

  await historyStore.saveCachedHistory({
    accountEmail: VICTIM,
    builtAt: new Date(0).toISOString(),
    contacts: {},
    engagedCount: 0,
    contactCount: 0,
  });
  assert.equal(await historyStore.loadCachedHistory(VICTIM), null, "stale history is a miss");
  await assertNavigationRefused(
    "classifier export with a cold history cache",
    googleCookie,
    "/api/classifier/samples",
    null,
    (request) => callIfPresent(samplesRoute.GET, request),
  );
  await assertNavigationRefused(
    "classifier export for a Microsoft mailbox",
    microsoftCookie,
    "/api/classifier/samples",
    ATTACKER,
    (request) => callIfPresent(samplesRoute.GET, request),
  );

  resetCalls();
  const outlookAllowed = await callRoute(
    samplesRoute.GET,
    requestFor("/api/classifier/samples", microsoftCookie, SITE),
  );
  if (outlookAllowed.status === 405 && typeof samplesRoute.POST === "function") {
    resetCalls();
    const posted = await callRoute(
      samplesRoute.POST,
      requestFor("/api/classifier/samples", microsoftCookie, SITE, "POST"),
    );
    assert.equal(posted.status, 200);
  } else {
    assert.equal(outlookAllowed.status, 200);
    const graphInbox = providerCalls.filter((call) =>
      call.url.includes("graph.microsoft.com") &&
      call.url.includes("mailFolders/inbox/messages"),
    );
    assert.equal(graphInbox.length >= 1, true, "Outlook export lists the inbox");
    assert.equal(graphInbox[0]?.authorization, `Bearer ${ACCESS_TOKEN}`);
    assert.ok(graphInbox.every((call) => call.authorization === `Bearer ${ACCESS_TOKEN}`));
  }

  const siblings: {
    label: string;
    pathname: string;
    invoke: (request: Request) => Promise<Response>;
  }[] = [
    {
      label: "alltasks",
      pathname: "/api/alltasks",
      invoke: (request) => callIfPresent(alltasksRoute.GET, request),
    },
    {
      label: "unsub-agent",
      pathname: "/api/unsub-agent",
      invoke: (request) => callIfPresent(unsubRoute.GET, request),
    },
    {
      label: "today",
      pathname: "/api/today",
      invoke: (request) => callIfPresent(todayRoute.GET, request),
    },
    {
      label: "mailbox",
      pathname: "/api/mailbox",
      invoke: (request) => callIfPresent(mailboxRoute.GET, request),
    },
    {
      label: "catchup",
      pathname: "/api/catchup",
      invoke: (request) => callIfPresent(catchupRoute.GET, request),
    },
    {
      label: "contacts",
      pathname: "/api/contacts",
      invoke: (request) => callIfPresent(contactsRoute.GET, request),
    },
    {
      label: "vips",
      pathname: "/api/vips",
      invoke: (request) => callIfPresent(vipsRoute.GET, request),
    },
    {
      label: "waiting",
      pathname: "/api/waiting?fresh=1",
      invoke: (request) => callIfPresent(waitingRoute.GET, request),
    },
    {
      label: "message",
      pathname: "/api/messages/provider-message",
      invoke: (request) =>
        callIfPresent(messageRoute.GET, request, {
          params: Promise.resolve({ id: "provider-message" }),
        }),
    },
    {
      label: "attachment",
      pathname:
        "/api/messages/provider-message/attachment?aid=placeholder-attachment",
      invoke: (request) =>
        callIfPresent(attachmentRoute.GET, request, {
          params: Promise.resolve({ id: "provider-message" }),
        }),
    },
  ];

  await lastOpen.markOpened(VICTIM);

  for (const sibling of siblings) {
    await forgetProviderCaches();
    resetCalls();
    try {
      await sibling.invoke(requestFor(sibling.pathname, googleCookie, SITE));
    } catch (error) {
      failures.push(
        `${sibling.label} same-origin control threw: ${error instanceof Error ? error.message : error}`,
      );
      continue;
    }
    if (providerCalls.length === 0) {
      failures.push(
        `${sibling.label} same-origin control did not reach a provider, so a refusal would be unproven`,
      );
      continue;
    }
    await forgetProviderCaches();
    await assertNavigationRefused(
      sibling.label,
      googleCookie,
      sibling.pathname,
      null,
      sibling.invoke,
    );
    await forgetProviderCaches();
    await assertNavigationRefused(
      `${sibling.label} foreign Origin`,
      googleCookie,
      sibling.pathname,
      ATTACKER,
      sibling.invoke,
    );
  }

  if (failures.length) {
    assert.fail(`navigation still reaches the mailbox:\n${failures.join("\n")}`);
  }

  console.log("classifier-export-csrf: OK");
} finally {
  globalThis.fetch = originalFetch;
  await db.stop();
}
