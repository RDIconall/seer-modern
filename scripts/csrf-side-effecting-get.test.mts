/**
 * Cross-site GET must not spend a signed-in mailbox's provider quota or
 * rewrite the relationship / calendar caches.
 *
 * These assertions fail while that behavior is still present. A same-origin
 * fetch, which is how the app loads VIP suggestions, must keep rebuilding a
 * stale cache.
 *
 * Run: npx tsx scripts/csrf-side-effecting-get.test.mts
 */
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const VICTIM_EMAIL = "victim@rditrials.com";
const OTHER_EMAIL = "other@rditrials.com";
const MICROSOFT_EMAIL = "victim.ms@rditrials.com";
const APP_ORIGIN = "https://seer.example";
const VICTIM_TOKEN = "placeholder-access-token";
const OTHER_TOKEN = "placeholder-other-access-token";
const MICROSOFT_TOKEN = "placeholder-microsoft-access-token";

process.env.AUTH_SECRET = "placeholder-auth-secret";
process.env.AUTH_URL = APP_ORIGIN;
process.env.NODE_ENV = "test";
delete process.env.POSTGRES_URL;
delete process.env.POSTGRES_PRISMA_URL;
delete process.env.DATABASE_URL;
delete process.env.SEER_V2_DATABASE_URL;
delete process.env.UPSTASH_REDIS_REST_URL;
delete process.env.UPSTASH_REDIS_REST_TOKEN;
delete process.env.KV_REST_API_URL;
delete process.env.KV_REST_API_TOKEN;
delete process.env.VERCEL;
delete process.env.GEMINI_API_KEY;
delete process.env.GOOGLE_GENERATIVE_AI_API_KEY;
delete process.env.AI_GATEWAY_API_KEY;
delete process.env.VERCEL_OIDC_TOKEN;
delete process.env.CRON_SECRET;

const dataDir = await mkdtemp(path.join(os.tmpdir(), "seer-csrf-data-"));
process.env.SEER_DATA_DIR = dataDir;

// embedded-postgres ships the libraries but not the SONAME symlinks initdb loads.
const pgLib = path.join(
  ROOT,
  "node_modules/@embedded-postgres/linux-x64/native/lib",
);
const pgSonameDir = await mkdtemp(path.join(os.tmpdir(), "seer-csrf-pglib-"));
for (const [source, name] of [
  ["libpq.so.5.18", "libpq.so.5"],
  ["libicuuc.so.60.2", "libicuuc.so.60"],
  ["libicudata.so.60.2", "libicudata.so.60"],
  ["libicui18n.so.60.2", "libicui18n.so.60"],
] as const) {
  await symlink(path.join(pgLib, source), path.join(pgSonameDir, name));
}
process.env.LD_LIBRARY_PATH = [pgLib, pgSonameDir, process.env.LD_LIBRARY_PATH]
  .filter(Boolean)
  .join(":");

const { setRequestHeaders, drainAfter } = await import("./load-next-probe.mts");

type Call = { url: string; authorization: string };
const calls: Call[] = [];

function providerBody(url: string): unknown {
  if (url.includes("/attachments/")) return { data: "" };
  if (url.includes("/users/me/messages/") || url.includes("/users/me/threads/")) {
    return {
      id: "m1",
      threadId: "t1",
      snippet: "",
      internalDate: String(Date.now()),
      labelIds: [],
      payload: {
        mimeType: "text/plain",
        headers: [
          { name: "From", value: "Ada <ada@example.com>" },
          { name: "To", value: VICTIM_EMAIL },
          { name: "Subject", value: "Hello" },
        ],
        body: { data: "" },
      },
      messages: [],
    };
  }
  if (url.includes("/users/me/messages")) return { messages: [] };
  if (url.includes("/users/me/labels")) return { labels: [] };
  if (url.includes("/users/me/threads")) return { threads: [] };
  if (url.includes("people.googleapis.com") && url.includes("otherContacts")) {
    return { otherContacts: [] };
  }
  if (url.includes("people.googleapis.com")) return { connections: [] };
  if (url.includes("calendar")) return { items: [] };
  if (url.includes("graph.microsoft.com")) return { value: [] };
  return {};
}

function isProviderUrl(url: string): boolean {
  return /^https:\/\/([a-z0-9.-]+\.)?(googleapis\.com|googleusercontent\.com|graph\.microsoft\.com|login\.microsoftonline\.com)(\/|$)/i.test(
    url,
  );
}

globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
  const url =
    typeof input === "string"
      ? input
      : input instanceof URL
        ? input.toString()
        : input.url;
  const headerBag = new Headers(
    input instanceof Request ? input.headers : undefined,
  );
  if (init?.headers) new Headers(init.headers).forEach((value, key) => headerBag.set(key, value));
  if (!isProviderUrl(url)) {
    throw new Error(`unexpected outbound fetch ${url}`);
  }
  calls.push({ url, authorization: headerBag.get("authorization") ?? "" });
  return new Response(JSON.stringify(providerBody(url)), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
};

const require = createRequire(import.meta.url);
const { defaultCookies } = require(
  path.join(ROOT, "node_modules/@auth/core/lib/utils/cookie.js"),
) as { defaultCookies: (useSecureCookies: boolean) => { sessionToken: { name: string; options: { sameSite: string; httpOnly: boolean; secure: boolean } } } };
const { encode } = await import("@auth/core/jwt");
const { startTestDb } = await import("./v2-testdb.mts");
const { upsertUser, upsertAccount, saveCredentials } = await import(
  "../src/lib/v2/db/accounts.ts"
);
const { accountKey, kvSet } = await import("../src/lib/store/kv.ts");

const secureCookie = defaultCookies(true).sessionToken;
assert.equal(secureCookie.options.sameSite, "lax");
assert.equal(secureCookie.options.httpOnly, true);
assert.equal(secureCookie.options.secure, true);
assert.equal(secureCookie.name, "__Secure-authjs.session-token");
assert.equal(defaultCookies(false).sessionToken.options.sameSite, "lax");

const db = await startTestDb();

async function seedAccount(
  email: string,
  provider: "google" | "microsoft",
  accessToken: string,
) {
  const userId = await upsertUser(email);
  const accountId = await upsertAccount({
    userId,
    provider,
    email,
    displayName: email,
  });
  await saveCredentials(accountId, provider, {
    accessToken,
    expiresAt: Date.now() + 60 * 60 * 1000,
  });
  return accountId;
}

await seedAccount(VICTIM_EMAIL, "google", VICTIM_TOKEN);
await seedAccount(OTHER_EMAIL, "google", OTHER_TOKEN);
await seedAccount(MICROSOFT_EMAIL, "microsoft", MICROSOFT_TOKEN);

async function sessionCookie(
  email: string,
  provider: "google" | "microsoft-entra-id",
): Promise<string> {
  const token = await encode({
    secret: process.env.AUTH_SECRET!,
    salt: secureCookie.name,
    token: {
      sub: email,
      email,
      name: email,
      provider,
    },
  });
  return `${secureCookie.name}=${token}`;
}

const victimCookie = await sessionCookie(VICTIM_EMAIL, "google");
const microsoftCookie = await sessionCookie(
  MICROSOFT_EMAIL,
  "microsoft-entra-id",
);

type HeaderMap = Record<string, string>;

function crossSiteNavigation(cookie: string): HeaderMap {
  return {
    cookie,
    host: "seer.example",
    "x-forwarded-proto": "https",
    "x-forwarded-host": "seer.example",
    "sec-fetch-site": "cross-site",
    "sec-fetch-mode": "navigate",
    "sec-fetch-dest": "document",
    "upgrade-insecure-requests": "1",
  };
}

function sameOriginFetch(cookie: string): HeaderMap {
  return {
    cookie,
    host: "seer.example",
    "x-forwarded-proto": "https",
    "x-forwarded-host": "seer.example",
    referer: `${APP_ORIGIN}/inbox`,
    "sec-fetch-site": "same-origin",
    "sec-fetch-mode": "cors",
    "sec-fetch-dest": "empty",
  };
}

function sameOriginNavigation(cookie: string): HeaderMap {
  return {
    cookie,
    host: "seer.example",
    "x-forwarded-proto": "https",
    "x-forwarded-host": "seer.example",
    referer: `${APP_ORIGIN}/inbox`,
    "sec-fetch-site": "same-origin",
    "sec-fetch-mode": "navigate",
    "sec-fetch-dest": "document",
  };
}

async function withRequest(
  headers: HeaderMap,
  _url: URL,
  run: () => Promise<Response>,
): Promise<Response> {
  setRequestHeaders(new Headers(headers));
  try {
    return await run();
  } finally {
    await drainAfter();
  }
}

async function resetStore() {
  await rm(dataDir, { recursive: true, force: true });
  calls.length = 0;
}

async function storeSnapshot(): Promise<Record<string, string>> {
  const names = await readdir(dataDir).catch(() => [] as string[]);
  const out: Record<string, string> = {};
  for (const name of names) {
    out[name] = await readFile(path.join(dataDir, name), "utf8");
  }
  return out;
}

function storeChanged(
  before: Record<string, string>,
  after: Record<string, string>,
): string[] {
  const names = new Set([...Object.keys(before), ...Object.keys(after)]);
  return [...names].filter((name) => before[name] !== after[name]).sort();
}

function bearerToken(authorization: string): string {
  const match = authorization.match(/^Bearer\s+(\S+)/);
  return match?.[1] ?? "";
}

function assertOnlyVictimToken(expected: string) {
  for (const call of calls) {
    const token = bearerToken(call.authorization);
    assert.equal(
      token,
      expected,
      `provider call used a different mailbox token: ${call.url}`,
    );
    assert.notEqual(token, OTHER_TOKEN);
  }
}

const vips = await import("../src/app/api/vips/route.ts");
const contacts = await import("../src/app/api/contacts/route.ts");
const alltasks = await import("../src/app/api/alltasks/route.ts");
const mailbox = await import("../src/app/api/mailbox/route.ts");
const today = await import("../src/app/api/today/route.ts");
const message = await import("../src/app/api/messages/[id]/route.ts");
const attachment = await import(
  "../src/app/api/messages/[id]/attachment/route.ts"
);
const catchup = await import("../src/app/api/catchup/route.ts");
const samples = await import("../src/app/api/classifier/samples/route.ts");
const waiting = await import("../src/app/api/waiting/route.ts");
const unsub = await import("../src/app/api/unsub-agent/route.ts");
const mail = await import("../src/app/api/mail/route.ts");
const v2Inbox = await import("../src/app/api/v2/inbox/route.ts");
const v3Mailbox = await import("../src/app/api/v3/mailbox/route.ts");

async function invoke(
  headers: HeaderMap,
  href: string,
  run: (request: Request) => Promise<Response>,
): Promise<{ status: number; changed: string[] }> {
  const before = await storeSnapshot();
  const url = new URL(href);
  const request = new Request(url, { method: "GET", headers });
  const response = await withRequest(headers, url, () => run(request));
  const changed = storeChanged(before, await storeSnapshot());
  return { status: response.status, changed };
}

async function expectNoProviderEffect(
  label: string,
  headers: HeaderMap,
  href: string,
  run: (request: Request) => Promise<Response>,
) {
  await resetStore();
  const result = await invoke(headers, href, run);
  assert.equal(
    calls.length,
    0,
    `${label} called a provider (${calls.map((c) => c.url).join(", ")}) status=${result.status}`,
  );
  assert.deepEqual(
    result.changed,
    [],
    `${label} rewrote stored state (${result.changed.join(", ")}) status=${result.status}`,
  );
}

await resetStore();
const allowed = await invoke(
  sameOriginFetch(victimCookie),
  `${APP_ORIGIN}/api/vips`,
  () => vips.GET(),
);
assert.ok(
  calls.some((call) => call.url.includes("gmail.googleapis.com")),
  "same-origin fetch should list mail when the relationship cache is empty",
);
assert.ok(
  calls.some((call) => call.url.includes("people.googleapis.com")),
  "same-origin fetch should refresh contacts when that cache is empty",
);
assert.ok(
  calls.some((call) => call.url.includes("calendar")),
  "same-origin fetch should refresh calendar when that cache is empty",
);
assertOnlyVictimToken(VICTIM_TOKEN);
assert.ok(
  allowed.changed.some((name) => name.includes("mail-history")),
  "same-origin fetch should write the relationship cache",
);
assert.ok(
  allowed.changed.some((name) => name.includes("personal")),
  "same-origin fetch should write the calendar cache",
);

const failures: string[] = [];
async function check(label: string, run: () => Promise<void>) {
  try {
    await run();
    console.log("PASS", label);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    failures.push(`${label}: ${message}`);
    console.log("FAIL", label, message);
  }
}

await check("cross-site GET /api/vips with empty caches", () =>
  expectNoProviderEffect(
    "cross-site GET /api/vips",
    crossSiteNavigation(victimCookie),
    `${APP_ORIGIN}/api/vips`,
    () => vips.GET(),
  ),
);

await check("cross-site GET /api/vips with a stale relationship cache", async () => {
  await resetStore();
  const builtAt = new Date(Date.now() - 16 * 60 * 1000).toISOString();
  const fresh = new Date().toISOString();
  await kvSet(`mail-history:${accountKey(VICTIM_EMAIL)}`, {
    builtAt,
    history: {
      accountEmail: VICTIM_EMAIL,
      builtAt,
      contacts: {},
      engagedCount: 0,
      contactCount: 0,
    },
  });
  await kvSet(`personal:${accountKey(VICTIM_EMAIL)}`, {
    builtAt: fresh,
    eventsBuiltAt: fresh,
    contacts: ["ada@example.com"],
    events: [],
    health: { people: "ok", calendar: "ok" },
  });
  calls.length = 0;
  const before = await storeSnapshot();
  const result = await invoke(
    crossSiteNavigation(victimCookie),
    `${APP_ORIGIN}/api/vips`,
    () => vips.GET(),
  );
  assert.equal(calls.length, 0, `listed mail: ${calls.map((c) => c.url).join(", ")}`);
  assert.deepEqual(storeChanged(before, await storeSnapshot()), []);
  assert.ok(result.status === 200 || result.status === 403);
});

await check("cross-site GET /api/vips with a stale calendar cache", async () => {
  await resetStore();
  const fresh = new Date().toISOString();
  const stale = new Date(Date.now() - 6 * 60 * 1000).toISOString();
  await kvSet(`mail-history:${accountKey(VICTIM_EMAIL)}`, {
    builtAt: fresh,
    history: {
      accountEmail: VICTIM_EMAIL,
      builtAt: fresh,
      contacts: {},
      engagedCount: 0,
      contactCount: 0,
    },
  });
  await kvSet(`personal:${accountKey(VICTIM_EMAIL)}`, {
    builtAt: fresh,
    eventsBuiltAt: stale,
    contacts: ["ada@example.com"],
    events: [],
    health: { people: "ok", calendar: "ok" },
  });
  calls.length = 0;
  const before = await storeSnapshot();
  await invoke(
    crossSiteNavigation(victimCookie),
    `${APP_ORIGIN}/api/vips`,
    () => vips.GET(),
  );
  assert.equal(
    calls.length,
    0,
    `refreshed calendar or contacts: ${calls.map((c) => c.url).join(", ")}`,
  );
  assert.deepEqual(storeChanged(before, await storeSnapshot()), []);
});

await check("same-origin navigation GET /api/vips", () =>
  expectNoProviderEffect(
    "same-origin navigation GET /api/vips",
    sameOriginNavigation(victimCookie),
    `${APP_ORIGIN}/api/vips`,
    () => vips.GET(),
  ),
);

await check("GET /api/vips with no fetch metadata", () =>
  expectNoProviderEffect(
    "GET /api/vips without fetch metadata",
    {
      cookie: victimCookie,
      host: "seer.example",
      "x-forwarded-proto": "https",
    },
    `${APP_ORIGIN}/api/vips`,
    () => vips.GET(),
  ),
);

await check("cross-site GET /api/vips for Microsoft", () =>
  expectNoProviderEffect(
    "cross-site GET /api/vips microsoft",
    crossSiteNavigation(microsoftCookie),
    `${APP_ORIGIN}/api/vips`,
    () => vips.GET(),
  ),
);

const siblings: Array<{
  label: string;
  href: string;
  run: (request: Request) => Promise<Response>;
  prepare?: () => Promise<void>;
}> = [
  {
    label: "GET /api/contacts",
    href: `${APP_ORIGIN}/api/contacts`,
    run: (request) => contacts.GET(request),
  },
  {
    label: "GET /api/alltasks",
    href: `${APP_ORIGIN}/api/alltasks`,
    run: () => alltasks.GET(),
  },
  {
    label: "GET /api/mailbox",
    href: `${APP_ORIGIN}/api/mailbox`,
    run: (request) => mailbox.GET(request),
  },
  {
    label: "GET /api/today",
    href: `${APP_ORIGIN}/api/today`,
    run: () => today.GET(),
  },
  {
    label: "GET /api/messages/[id]",
    href: `${APP_ORIGIN}/api/messages/m1`,
    run: (request) =>
      message.GET(request, { params: Promise.resolve({ id: "m1" }) }),
  },
  {
    label: "GET /api/messages/[id]/attachment",
    href: `${APP_ORIGIN}/api/messages/m1/attachment?aid=a1`,
    run: (request) =>
      attachment.GET(request, { params: Promise.resolve({ id: "m1" }) }),
  },
  {
    label: "GET /api/catchup",
    href: `${APP_ORIGIN}/api/catchup`,
    prepare: async () => {
      await kvSet(
        `last-open:${accountKey(VICTIM_EMAIL)}`,
        new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(),
      );
    },
    run: () => catchup.GET(),
  },
  {
    label: "GET /api/classifier/samples",
    href: `${APP_ORIGIN}/api/classifier/samples`,
    run: () => samples.GET(),
  },
  {
    label: "GET /api/waiting",
    href: `${APP_ORIGIN}/api/waiting`,
    run: (request) => waiting.GET(request),
  },
  {
    label: "GET /api/v2/inbox",
    href: `${APP_ORIGIN}/api/v2/inbox`,
    run: () => v2Inbox.GET(),
  },
  {
    label: "GET /api/v3/mailbox",
    href: `${APP_ORIGIN}/api/v3/mailbox`,
    run: (request) => v3Mailbox.GET(request),
  },
];

for (const sibling of siblings) {
  await check(`cross-site ${sibling.label}`, async () => {
    await resetStore();
    if (sibling.prepare) await sibling.prepare();
    calls.length = 0;
    const before = await storeSnapshot();
    const result = await invoke(
      crossSiteNavigation(victimCookie),
      sibling.href,
      sibling.run,
    );
    assert.equal(
      calls.length,
      0,
      `${sibling.label} called a provider (${calls.map((c) => c.url).join(", ")}) status=${result.status} changed=${result.changed.join(",")}`,
    );
    const changed = storeChanged(before, await storeSnapshot());
    assert.deepEqual(changed, [], `${sibling.label} rewrote ${changed.join(", ")}`);
  });
}

await check("cross-site GET /api/unsub-agent when the assistant is configured", async () => {
  process.env.VERCEL = "1";
  try {
    await expectNoProviderEffect(
      "cross-site GET /api/unsub-agent",
      crossSiteNavigation(victimCookie),
      `${APP_ORIGIN}/api/unsub-agent`,
      () => unsub.GET(),
    );
  } finally {
    delete process.env.VERCEL;
  }
});

await resetStore();
const anonymous = await invoke(
  crossSiteNavigation(""),
  `${APP_ORIGIN}/api/vips`,
  () => vips.GET(),
);
assert.equal(anonymous.status, 401);
assert.equal(calls.length, 0);
assert.deepEqual(anonymous.changed, []);

await resetStore();
const legacyMail = await invoke(
  crossSiteNavigation(victimCookie),
  `${APP_ORIGIN}/api/mail`,
  (request) => mail.GET(request),
);
assert.equal(legacyMail.status, 401);
assert.equal(calls.length, 0, "/api/mail must not call Gmail with the stripped session");

try {
  if (failures.length) {
    throw new Error(`${failures.length} cross-site GET side effect(s) still happen`);
  }
  console.log("csrf-side-effecting-get: OK");
} finally {
  await db.stop();
  await rm(dataDir, { recursive: true, force: true });
  await rm(pgSonameDir, { recursive: true, force: true });
}
