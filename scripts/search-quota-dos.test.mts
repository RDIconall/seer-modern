/**
 * Mailbox search must not let one signed-in browser navigation spend the
 * mailbox provider quota.
 *
 * These tests fail while that behavior is present. They pass once interactive
 * search is capped well below the sync page size, no longer downloads every
 * hit as a full thread, and a cross-site GET cannot start that work.
 *
 * Run: npx tsx scripts/search-quota-dos.test.mts
 *
 * Not covered here: the legacy GET /api/mailbox search (src/app/api/mailbox/route.ts).
 * That path hydrates Gmail hits with format=metadata at a concurrency of 10 and
 * asks Graph for bodyPreview, not the message body. It is a different cost.
 */
process.env.AUTH_SECRET = "placeholder-auth-secret";
process.env.NODE_ENV = "production";
process.env.SEER_CREDENTIAL_KEY = Buffer.alloc(32, 9).toString("base64");

const { createRequire } = await import("node:module");
const require = createRequire(import.meta.url);
const assert = (await import("node:assert/strict")).default;
const { encode } = await import("@auth/core/jwt");
const { pathToFileURL, fileURLToPath } = await import("node:url");
const path = await import("node:path");
const { defaultCookies } = (await import(
  pathToFileURL(
    path.join(
      path.dirname(fileURLToPath(import.meta.url)),
      "../node_modules/@auth/core/lib/utils/cookie.js",
    ),
  ).href
)) as {
  defaultCookies: (useSecureCookies: boolean) => {
    sessionToken: { name: string; options: { sameSite: string } };
  };
};
const { startTestDb } = await import("./v2-testdb.mts");
const { upsertUser, upsertAccount, saveCredentials } = await import(
  "../src/lib/v2/db/accounts.ts"
);
const { GmailProvider } = await import("../src/lib/v2/providers/gmail.ts");
const { OutlookProvider } = await import("../src/lib/v2/providers/outlook.ts");
const { parseMailHash } = await import("../src/components/v3/mail-client-state.ts");

if (typeof globalThis.AsyncLocalStorage !== "function") {
  const { AsyncLocalStorage } = await import("node:async_hooks");
  globalThis.AsyncLocalStorage = AsyncLocalStorage;
}
const { workAsyncStorage } = require(
  "next/dist/server/app-render/work-async-storage.external.js",
);
const { workUnitAsyncStorage } = require(
  "next/dist/server/app-render/work-unit-async-storage.external.js",
);
const { HeadersAdapter } = require(
  "next/dist/server/web/spec-extension/adapters/headers.js",
);
const { RequestCookiesAdapter } = require(
  "next/dist/server/web/spec-extension/adapters/request-cookies.js",
);
const { RequestCookies } = require("next/dist/server/web/spec-extension/cookies.js");

/**
 * Sync defaults are 100 threads (Gmail) and 50 messages (Outlook). Interactive
 * search has to stay well below both, and one search cannot fan out into a
 * hundred parallel provider reads.
 */
const INTERACTIVE_PAGE_MAX = 20;
const INTERACTIVE_PARALLEL_MAX = 4;
const APP_ORIGIN = "http://seer.test";

type Recorded = { url: string; started: number };

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function gmailMessage(id: string) {
  const data = Buffer.from(`body ${id}`, "utf8").toString("base64url");
  return {
    id: `${id}-m`,
    threadId: id,
    snippet: `snippet ${id}`,
    labelIds: ["INBOX"],
    internalDate: "1600000000000",
    payload: {
      mimeType: "text/plain",
      headers: [
        { name: "From", value: "sender@example.com" },
        { name: "To", value: "victim@rditrials.com" },
        { name: "Subject", value: `Subject ${id}` },
      ],
      body: { size: data.length, data },
    },
  };
}

function isPerHitRead(url: string): boolean {
  const path = new URL(url).pathname;
  return /\/threads\/[^/]+$/.test(path) || /\/messages\/[^/]+$/.test(path);
}

function installFetch(handler: (url: string, init?: RequestInit) => Promise<Response>) {
  const original = globalThis.fetch;
  const calls: Recorded[] = [];
  let inFlight = 0;
  let peak = 0;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    calls.push({ url, started: inFlight + 1 });
    inFlight += 1;
    peak = Math.max(peak, inFlight);
    try {
      return await handler(url, init);
    } finally {
      inFlight -= 1;
    }
  }) as typeof fetch;
  return {
    calls,
    peak: () => peak,
    restore() {
      globalThis.fetch = original;
    },
  };
}

const failures: string[] = [];

function check(condition: unknown, message: string) {
  if (!condition) failures.push(message);
}

function assertBoundedGmailSearch(calls: Recorded[], peak: number, query: string) {
  const lists = calls.filter((call) => new URL(call.url).pathname.endsWith("/threads"));
  const list = lists[0] ? new URL(lists[0].url) : null;
  const maxResults = Number(list?.searchParams.get("maxResults"));
  const perHit = calls.filter((call) => isPerHitRead(call.url));
  const fullReads = calls.filter((call) => call.url.includes("format=full"));
  check(lists.length === 1, `Gmail search made ${lists.length} list calls`);
  check(
    maxResults > 0 && maxResults <= INTERACTIVE_PAGE_MAX,
    `Gmail search maxResults must be 1..${INTERACTIVE_PAGE_MAX}, was ${maxResults}`,
  );
  check(
    (list?.searchParams.get("q") ?? "").includes(query),
    `Gmail search must forward the caller query, got ${list?.searchParams.get("q")}`,
  );
  check(perHit.length === 0, `Gmail search downloaded ${perHit.length} threads one by one`);
  check(fullReads.length === 0, `Gmail search requested format=full ${fullReads.length} times`);
  check(
    peak <= INTERACTIVE_PARALLEL_MAX,
    `Gmail search peaked at ${peak} in-flight provider calls`,
  );
}

function assertBoundedOutlookSearch(calls: Recorded[], peak: number, query: string) {
  const list = calls[0] ? new URL(calls[0].url) : null;
  const top = Number(list?.searchParams.get("$top"));
  const select = (list?.searchParams.get("$select") ?? "")
    .split(",")
    .map((part) => part.trim());
  check(calls.length === 1, `Outlook search made ${calls.length} provider calls`);
  check(
    top > 0 && top <= INTERACTIVE_PAGE_MAX,
    `Outlook search $top must be 1..${INTERACTIVE_PAGE_MAX}, was ${top}`,
  );
  check(!select.includes("body"), `Outlook search selected the body field: ${select.join(",")}`);
  check(
    decodeURIComponent(list?.searchParams.get("$search") ?? "").includes(query),
    "Outlook search must forward the caller query",
  );
  check(peak <= INTERACTIVE_PARALLEL_MAX, `Outlook search peaked at ${peak} in-flight calls`);
}

function gmailFetch(url: string): Promise<Response> {
  const parsed = new URL(url);
  if (parsed.pathname.endsWith("/threads")) {
    const max = Number(parsed.searchParams.get("maxResults") ?? "0");
    const count = Math.min(Math.max(max, 0), 100);
    return Promise.resolve(
      jsonResponse({
        threads: Array.from({ length: count }, (_, index) => ({
          id: `t${index}`,
          snippet: `snippet t${index}`,
        })),
        resultSizeEstimate: count,
      }),
    );
  }
  const thread = parsed.pathname.match(/\/threads\/([^/]+)$/);
  if (thread) {
    return Promise.resolve(
      jsonResponse({
        id: thread[1],
        messages: [gmailMessage(thread[1])],
      }),
    );
  }
  return Promise.reject(new Error(`unexpected Gmail request ${parsed.pathname}`));
}

function outlookFetch(url: string): Promise<Response> {
  const parsed = new URL(url);
  if (parsed.pathname.endsWith("/messages")) {
    const top = Number(parsed.searchParams.get("$top") ?? "0");
    const count = Math.min(Math.max(top, 0), 50);
    return Promise.resolve(
      jsonResponse({
        value: Array.from({ length: count }, (_, index) => ({
          id: `m${index}`,
          conversationId: `c${index}`,
          subject: `Subject ${index}`,
          bodyPreview: `preview ${index}`,
          body: { contentType: "html", content: `<p>full body ${index}</p>` },
          from: { emailAddress: { address: "sender@example.com" } },
          toRecipients: [{ emailAddress: { address: "victim@rditrials.com" } }],
          receivedDateTime: "2026-08-01T00:00:00Z",
          isRead: false,
        })),
      }),
    );
  }
  return Promise.reject(new Error(`unexpected Graph request ${parsed.pathname}`));
}

const attackerQuery = parseMailHash("#q=in%3Aanywhere").query;
assert.equal(attackerQuery, "in:anywhere");

{

  const probe = installFetch((url) => gmailFetch(url));
  try {
    const found = await new GmailProvider({
      accessToken: "placeholder-access-token",
      accountEmail: "victim@rditrials.com",
    }).search(attackerQuery ?? "", null);
    assertBoundedGmailSearch(probe.calls, probe.peak(), "in:anywhere");
    assert.ok(found.conversations.length > 0);
  } finally {
    probe.restore();
  }
}

{
  const probe = installFetch((url) => outlookFetch(url));
  try {
    const found = await new OutlookProvider({
      accessToken: "placeholder-access-token",
      accountEmail: "victim@rditrials.com",
    }).search(attackerQuery ?? "", null);
    assertBoundedOutlookSearch(probe.calls, probe.peak(), "in:anywhere");
    assert.ok(found.conversations.length > 0);
  } finally {
    probe.restore();
  }
}

const fs = await import("node:fs/promises");
const os = await import("node:os");
const embeddedLib = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "../node_modules/@embedded-postgres/linux-x64/native/lib",
);
const icuLinks = await fs.mkdtemp(path.join(os.tmpdir(), "seer-icu-"));
for (const [soname, file] of [
  ["libicuuc.so.60", "libicuuc.so.60.2"],
  ["libicudata.so.60", "libicudata.so.60.2"],
  ["libicui18n.so.60", "libicui18n.so.60.2"],
] as const) {
  await fs.symlink(path.join(embeddedLib, file), path.join(icuLinks, soname));
}
process.env.LD_LIBRARY_PATH = [icuLinks, embeddedLib, process.env.LD_LIBRARY_PATH]
  .filter(Boolean)
  .join(":");

const db = await startTestDb();
try {
  const userId = await upsertUser("victim@rditrials.com");
  const googleAccount = await upsertAccount({
    userId,
    provider: "google",
    email: "victim@rditrials.com",
  });
  const microsoftAccount = await upsertAccount({
    userId,
    provider: "microsoft",
    email: "victim.outlook@rditrials.com",
  });
  const expiresAt = Date.now() + 24 * 60 * 60 * 1000;
  await saveCredentials(googleAccount, "google", {
    accessToken: "placeholder-access-token",
    refreshToken: "placeholder-refresh-token",
    expiresAt,
  });
  await saveCredentials(microsoftAccount, "microsoft", {
    accessToken: "placeholder-access-token",
    refreshToken: "placeholder-refresh-token",
    expiresAt,
  });

  const cookieName = defaultCookies(false).sessionToken.name;
  assert.equal(cookieName, "authjs.session-token");
  assert.equal(defaultCookies(true).sessionToken.options.sameSite, "lax");

  async function sessionCookie(activeAccountId: string, provider: string): Promise<string> {
    const token = await encode({
      salt: cookieName,
      secret: process.env.AUTH_SECRET ?? "",
      token: {
        email: "victim@rditrials.com",
        sub: "victim",
        activeAccountId,
        provider,
      },
    });
    return `${cookieName}=${token}`;
  }

  const route = await import("../src/app/api/v3/search/route.ts");

  async function callSearch(
    accountId: string,
    provider: "google" | "microsoft",
    headers: Record<string, string>,
    method: "GET" | "POST",
  ): Promise<{ status: number; body: unknown; calls: Recorded[]; peak: number }> {
    const cookie = await sessionCookie(accountId, provider === "google" ? "google" : "microsoft-entra-id");
    const headerBag = new Headers({
      host: "seer.test",
      "x-forwarded-proto": "http",
      cookie,
      ...headers,
    });
    const query = attackerQuery ?? "";
    const url =
      method === "GET"
        ? `${APP_ORIGIN}/api/v3/search?q=${encodeURIComponent(query)}`
        : `${APP_ORIGIN}/api/v3/search`;
    const request = new Request(url, {
      method,
      headers: headerBag,
      body: method === "POST" ? JSON.stringify({ q: query }) : undefined,
    });
    const fetchProbe = installFetch((target) =>
      provider === "google" ? gmailFetch(target) : outlookFetch(target),
    );
    try {
      const workStore = {
        route: "/api/v3/search",
        forceStatic: false,
        dynamicShouldError: false,
      };
      const cookies = RequestCookiesAdapter.seal(new RequestCookies(headerBag));
      const workUnit = {
        type: "request",
        phase: "render",
        headers: HeadersAdapter.seal(headerBag),
        cookies,
        userspaceMutableCookies: cookies,
      };
      const handler = method === "POST" ? route.POST : route.GET;
      if (typeof handler !== "function") {
        return { status: 405, body: null, calls: fetchProbe.calls, peak: fetchProbe.peak() };
      }
      const response = await workAsyncStorage.run(workStore, () =>
        workUnitAsyncStorage.run(workUnit, () => handler(request)),
      );
      const body = await response.json().catch(() => null);
      return {
        status: response.status,
        body,
        calls: fetchProbe.calls,
        peak: fetchProbe.peak(),
      };
    } finally {
      fetchProbe.restore();
    }
  }

  const crossSite = {
    "sec-fetch-site": "cross-site",
    "sec-fetch-mode": "navigate",
    "sec-fetch-dest": "document",
  };
  const sameOrigin = {
    "sec-fetch-site": "same-origin",
    "sec-fetch-mode": "cors",
    "sec-fetch-dest": "empty",
  };

  for (const [provider, accountId] of [
    ["google", googleAccount],
    ["microsoft", microsoftAccount],
  ] as const) {
    const crossed = await callSearch(accountId, provider, crossSite, "GET");
    check(
      crossed.calls.length === 0,
      `${provider} cross-site GET contacted the provider ${crossed.calls.length} times (status ${crossed.status})`,
    );
    check(
      crossed.status === 403 || crossed.status === 405,
      `${provider} cross-site GET must be refused, got ${crossed.status}`,
    );

    let interactive = await callSearch(accountId, provider, sameOrigin, "GET");
    if (interactive.status !== 200 && typeof route.POST === "function") {
      interactive = await callSearch(accountId, provider, {
        ...sameOrigin,
        origin: APP_ORIGIN,
        "content-type": "application/json",
      }, "POST");
    }
    check(interactive.status === 200, `${provider} same-origin search status ${interactive.status}`);
    const view = interactive.body as { view?: { rows?: unknown[] } } | null;
    check((view?.view?.rows?.length ?? 0) > 0, `${provider} same-origin search returned no rows`);
    if (provider === "google") {
      assertBoundedGmailSearch(interactive.calls, interactive.peak, "in:anywhere");
    } else {
      assertBoundedOutlookSearch(interactive.calls, interactive.peak, "in:anywhere");
    }
  }
} finally {
  await db.stop();
}

if (failures.length > 0) {
  assert.fail(`\n${failures.join("\n")}`);
}

console.log("search-quota-dos: OK");
