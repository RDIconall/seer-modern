/**
 * Spec for the unsubscribe-agent cross-site GET.
 *
 * A signed-in top-level navigation must not list the mailbox or call the
 * model. The action belongs on POST, and only when the Origin matches the
 * app the way the v3 command routes already require. These assertions fail
 * while that GET still performs the inbox scan and the model call.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdtemp, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const APP_ORIGIN = "https://seer.test";
const AUTH_SECRET = "test-only-auth-secret";
const GEMINI_KEY = "test-only-gemini-key";
const OWNER_EMAIL = "victim@rditrials.com";
const OTHER_EMAIL = "other-box@rditrials.com";
const TOKEN_GOOGLE = "mailbox-token-google";
const TOKEN_MICROSOFT = "mailbox-token-microsoft";
const SENDER = "news@lists.example";

process.env.NODE_ENV = "test";
process.env.SEER_CREDENTIAL_KEY = Buffer.alloc(32, 7).toString("base64");
process.env.AUTH_SECRET = AUTH_SECRET;
process.env.AUTH_URL = APP_ORIGIN;
process.env.AUTH_TRUST_HOST = "1";
process.env.GEMINI_API_KEY = GEMINI_KEY;
process.env.SEER_GEMINI_MODEL = "gemini-2.0-flash";
process.env.SEER_DATA_DIR = await mkdtemp(path.join(tmpdir(), "seer-unsub-csrf-"));
delete process.env.GOOGLE_GENERATIVE_AI_API_KEY;
delete process.env.AI_GATEWAY_API_KEY;
delete process.env.VERCEL;
delete process.env.VERCEL_OIDC_TOKEN;
delete process.env.VERCEL_ENV;
delete process.env.POSTGRES_URL;
delete process.env.SEER_V2_DATABASE_URL;
delete process.env.UPSTASH_REDIS_REST_URL;
delete process.env.UPSTASH_REDIS_REST_TOKEN;
delete process.env.KV_REST_API_URL;
delete process.env.KV_REST_API_TOKEN;
delete process.env.SEER_V3_LEGACY_ACCOUNT_FALLBACK;

type Call = {
  host: string;
  path: string;
  authorization: string;
};

const calls: Call[] = [];

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function gmailBody(url: URL): unknown {
  const query = url.searchParams.get("q") ?? "";
  if (url.pathname.includes("/users/me/messages/") && url.pathname.split("/").length > 5) {
    return {
      id: "m1",
      threadId: "t1",
      snippet: "Weekly deals",
      internalDate: String(Date.now()),
      labelIds: ["INBOX", "UNREAD"],
      payload: {
        headers: [
          { name: "From", value: `News <${SENDER}>` },
          { name: "Subject", value: "Weekly deals" },
          { name: "To", value: OWNER_EMAIL },
        ],
      },
    };
  }
  if (query.includes("in:sent") || query.includes("in:trash")) {
    return { messages: [] };
  }
  return { messages: [{ id: "m1", threadId: "t1" }] };
}

function graphBody(url: URL): unknown {
  if (url.pathname.includes("/sentitems/") || url.pathname.includes("/deleteditems/")) {
    return { value: [] };
  }
  return {
    value: [
      {
        id: "g1",
        conversationId: "c1",
        subject: "Weekly deals",
        bodyPreview: "Weekly deals",
        receivedDateTime: new Date().toISOString(),
        isRead: false,
        from: { emailAddress: { name: "News", address: SENDER } },
        toRecipients: [{ emailAddress: { address: OTHER_EMAIL } }],
      },
    ],
  };
}

function modelBody(): unknown {
  return {
    candidates: [
      {
        content: {
          role: "model",
          parts: [
            {
              text: JSON.stringify({
                senders: [
                  {
                    email: SENDER,
                    unsubscribe: true,
                    phoneDup: false,
                    reason: "Coupon blasts you never open",
                  },
                ],
              }),
            },
          ],
        },
        finishReason: "STOP",
      },
    ],
    usageMetadata: {
      promptTokenCount: 10,
      candidatesTokenCount: 10,
      totalTokenCount: 20,
    },
  };
}

globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
  const raw =
    typeof input === "string"
      ? input
      : input instanceof URL
        ? input.toString()
        : input.url;
  const url = new URL(raw);
  const headers = new Headers(init?.headers);
  if (input instanceof Request) {
    input.headers.forEach((value, key) => {
      if (!headers.has(key)) headers.set(key, value);
    });
  }
  calls.push({
    host: url.host,
    path: url.pathname,
    authorization: headers.get("authorization") ?? "",
  });
  if (url.host === "gmail.googleapis.com") return json(gmailBody(url));
  if (url.host === "graph.microsoft.com") return json(graphBody(url));
  if (url.host === "generativelanguage.googleapis.com") return json(modelBody());
  return json({ error: "blocked by test" }, 599);
};

await import("../node_modules/next/dist/server/node-environment-baseline.js");
const { defaultCookies } = await import(
  "../node_modules/@auth/core/lib/utils/cookie.js"
);
const { encode } = await import("@auth/core/jwt");
const { serialize } = await import(
  "../node_modules/@auth/core/lib/vendored/cookie.js"
);
const { createRequestStoreForAPI } = await import(
  "../node_modules/next/dist/server/async-storage/request-store.js"
);
const { workAsyncStorageInstance } = await import(
  "../node_modules/next/dist/server/app-render/work-async-storage-instance.js"
);
const { workUnitAsyncStorageInstance } = await import(
  "../node_modules/next/dist/server/app-render/work-unit-async-storage-instance.js"
);
const { startTestDb } = await import("./v2-testdb.mts");
const accounts = await import("../src/lib/v2/db/accounts.ts");
const { ACTIVE_ACCOUNT_COOKIE } = await import("../src/lib/store/accounts.ts");
const unsubAgent = await import("../src/app/api/unsub-agent/route.ts");
const todayRoute = await import("../src/app/api/today/route.ts");
const mailboxRoute = await import("../src/app/api/mailbox/route.ts");
const allTasksRoute = await import("../src/app/api/alltasks/route.ts");
const catchupRoute = await import("../src/app/api/catchup/route.ts");
const samplesRoute = await import("../src/app/api/classifier/samples/route.ts");
const messageRoute = await import("../src/app/api/messages/[id]/route.ts");

const secureCookies = new URL(APP_ORIGIN).protocol === "https:";
const sessionCookie = defaultCookies(secureCookies).sessionToken;
assert.equal(sessionCookie.options.sameSite, "lax");
assert.equal(defaultCookies(false).sessionToken.options.sameSite, "lax");

const authSource = await import("node:fs/promises").then((fs) =>
  fs.readFile(new URL("../src/auth.ts", import.meta.url), "utf8"),
);
assert.equal(
  /cookies\s*:/.test(authSource),
  false,
  "the app does not replace Auth.js session cookie options",
);

const db = await startTestDb();

const userId = await accounts.upsertUser(OWNER_EMAIL);
const googleAccount = await accounts.upsertAccountWithCredentials({
  userId,
  provider: "google",
  email: OWNER_EMAIL,
  displayName: "Victim",
  accessToken: TOKEN_GOOGLE,
  refreshToken: "mailbox-refresh-google",
  expiresAt: Date.now() + 60 * 60 * 1000,
});
const microsoftAccount = await accounts.upsertAccountWithCredentials({
  userId,
  provider: "microsoft",
  email: OTHER_EMAIL,
  displayName: "Other box",
  accessToken: TOKEN_MICROSOFT,
  refreshToken: "mailbox-refresh-microsoft",
  expiresAt: Date.now() + 60 * 60 * 1000,
});

async function sessionCookieValue(): Promise<string> {
  return encode({
    token: {
      email: OWNER_EMAIL,
      name: "Victim",
      provider: "google",
      activeAccountId: googleAccount.id,
      expiresAt: Math.floor(Date.now() / 1000) + 60 * 60,
    },
    secret: AUTH_SECRET,
    salt: sessionCookie.name,
  });
}

const sessionValue = await sessionCookieValue();

function cookieHeader(activeAccountId: string): string {
  return `${sessionCookie.name}=${sessionValue}; ${ACTIVE_ACCOUNT_COOKIE}=${activeAccountId}`;
}

type InvokeResult = {
  status: number;
  body: unknown;
  calls: Call[];
  files: string[];
};

async function invoke(
  handler: ((request: Request, context?: unknown) => Promise<Response>) | undefined,
  request: Request,
  context?: unknown,
): Promise<InvokeResult> {
  const before = calls.length;
  const filesBefore = new Set(await readdir(process.env.SEER_DATA_DIR!));
  if (!handler) {
    return { status: 405, body: null, calls: [], files: [] };
  }
  const headerObject: Record<string, string> = {};
  request.headers.forEach((value, key) => {
    headerObject[key] = value;
  });
  const requestStore = createRequestStoreForAPI(
    { headers: headerObject },
    new URL(request.url),
    { tags: [] },
    undefined,
    undefined,
  );
  const deferred: Promise<unknown>[] = [];
  const workStore = {
    route: new URL(request.url).pathname,
    afterContext: {
      after(task: unknown) {
        const result = typeof task === "function" ? task() : task;
        if (result && typeof (result as Promise<unknown>).then === "function") {
          deferred.push(result as Promise<unknown>);
        }
      },
    },
  };
  let response: Response;
  try {
    response = await workUnitAsyncStorageInstance.run(requestStore, () =>
      workAsyncStorageInstance.run(workStore, () => handler(request, context)),
    );
    await Promise.allSettled(deferred);
  } catch (error) {
    const files = (await readdir(process.env.SEER_DATA_DIR!)).filter(
      (name) => !filesBefore.has(name),
    );
    throw new Error(
      `handler threw after ${calls.length - before} outbound calls and ${files.length} new files: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  const text = await response.text();
  let body: unknown = text;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  const files = (await readdir(process.env.SEER_DATA_DIR!)).filter(
    (name) => !filesBefore.has(name),
  );
  return {
    status: response.status,
    body,
    calls: calls.slice(before),
    files,
  };
}

function appRequest(
  method: string,
  pathname: string,
  init: {
    origin?: string | null;
    secFetchSite?: string;
    secFetchMode?: string;
    activeAccountId?: string;
    cookie?: boolean;
  } = {},
): Request {
  const headers = new Headers();
  if (init.cookie !== false) {
    headers.set(
      "cookie",
      cookieHeader(init.activeAccountId ?? googleAccount.id),
    );
  }
  headers.set("host", "seer.test");
  headers.set("x-forwarded-proto", "https");
  headers.set("x-forwarded-host", "seer.test");
  if (init.origin) headers.set("origin", init.origin);
  if (init.secFetchSite) headers.set("sec-fetch-site", init.secFetchSite);
  if (init.secFetchMode) headers.set("sec-fetch-mode", init.secFetchMode);
  return new Request(`${APP_ORIGIN}${pathname}`, { method, headers });
}

function providerCalls(result: InvokeResult): Call[] {
  return result.calls.filter(
    (call) =>
      call.host === "gmail.googleapis.com" ||
      call.host === "graph.microsoft.com" ||
      call.host === "generativelanguage.googleapis.com",
  );
}

function describe(result: InvokeResult): string {
  const outbound = providerCalls(result)
    .map((call) => `${call.host}${call.path}`)
    .join(", ");
  const body =
    result.body && typeof result.body === "object"
      ? JSON.stringify(result.body).slice(0, 300)
      : "";
  return `status ${result.status}; outbound [${outbound}]; new files ${result.files.length}; body ${body}`;
}

function assertRefusedBeforeSideEffects(result: InvokeResult, label: string) {
  assert.notEqual(
    result.status,
    401,
    `${label} must be an authenticated request, otherwise a 401 hides the handler. ${describe(result)}`,
  );
  assert.equal(
    providerCalls(result).length,
    0,
    `${label} must not list a mailbox or call the model. ${describe(result)}`,
  );
  assert.equal(
    result.files.length,
    0,
    `${label} must not write mail history or other state before refusing. ${describe(result)}`,
  );
  assert.ok(
    result.status === 403 || result.status === 405,
    `${label} must reject the action. ${describe(result)}`,
  );
}

await assertBrowserSendsLaxCookieOnNavigation();

const crossSiteGet = appRequest("GET", "/api/unsub-agent", {
  secFetchSite: "cross-site",
  secFetchMode: "navigate",
});
const crossSiteResult = await invoke(unsubAgent.GET, crossSiteGet);
assertRefusedBeforeSideEffects(
  crossSiteResult,
  "cross-site top-level GET /api/unsub-agent",
);

const sameOriginGet = await invoke(
  unsubAgent.GET,
  appRequest("GET", "/api/unsub-agent", {
    origin: APP_ORIGIN,
    secFetchSite: "same-origin",
    secFetchMode: "cors",
  }),
);
assertRefusedBeforeSideEffects(
  sameOriginGet,
  "same-origin GET /api/unsub-agent",
);

const headResult = await invoke(
  unsubAgent.GET,
  appRequest("HEAD", "/api/unsub-agent", {
    secFetchSite: "cross-site",
    secFetchMode: "navigate",
  }),
);
assertRefusedBeforeSideEffects(
  headResult,
  "HEAD /api/unsub-agent (Next serves HEAD with the GET handler)",
);

const anonymous = await invoke(
  unsubAgent.GET,
  appRequest("GET", "/api/unsub-agent", { cookie: false, secFetchSite: "cross-site" }),
);
assert.equal(anonymous.status, 401);
assert.equal(providerCalls(anonymous).length, 0);

async function assertPostRefused(origin: string | null, label: string) {
  const request = appRequest("POST", "/api/unsub-agent", {
    origin,
    secFetchSite: "cross-site",
    secFetchMode: "cors",
  });
  const result = await invoke(unsubAgent.POST, request);
  assertRefusedBeforeSideEffects(result, label);
}

await assertPostRefused("https://evil.test", "POST from a foreign Origin");
await assertPostRefused("null", "POST from a null Origin");
await assertPostRefused("https://seer.test.evil.test", "POST from a lookalike Origin");
await assertPostRefused("https://seer.test:444", "POST from the app host on another port");
const priorNodeEnv = process.env.NODE_ENV;
process.env.NODE_ENV = "production";
await assertPostRefused(null, "production POST with no Origin");
process.env.NODE_ENV = "development";
const devMissingOrigin = await invoke(
  unsubAgent.POST,
  appRequest("POST", "/api/unsub-agent", {
    secFetchSite: "same-origin",
    secFetchMode: "cors",
  }),
);
process.env.NODE_ENV = priorNodeEnv;
assert.notEqual(devMissingOrigin.status, 401, describe(devMissingOrigin));
assert.ok(
  providerCalls(devMissingOrigin).some((call) => call.host === "gmail.googleapis.com"),
  `a non-production POST with no Origin may run, matching the v3 origin helper. ${describe(devMissingOrigin)}`,
);
assert.ok(
  providerCalls(devMissingOrigin).some((call) =>
    call.path.includes(":generateContent"),
  ),
  `the allowed POST must reach the model when a bulk sender is present. ${describe(devMissingOrigin)}`,
);

async function assertAllowedPost(activeAccountId: string, token: string, host: string) {
  const result = await invoke(
    unsubAgent.POST,
    appRequest("POST", "/api/unsub-agent", {
      origin: APP_ORIGIN,
      secFetchSite: "same-origin",
      secFetchMode: "cors",
      activeAccountId,
    }),
  );
  assert.notEqual(result.status, 401, describe(result));
  assert.notEqual(result.status, 403, describe(result));
  assert.notEqual(result.status, 405, describe(result));
  const mailbox = providerCalls(result).filter((call) => call.host === host);
  assert.ok(mailbox.length > 0, `POST must read that mailbox. ${describe(result)}`);
  assert.ok(
    mailbox.every((call) => call.authorization === `Bearer ${token}`),
    `POST must use the active mailbox token. ${describe(result)}`,
  );
  assert.equal(
    providerCalls(result).some(
      (call) => call.authorization === `Bearer ${token === TOKEN_GOOGLE ? TOKEN_MICROSOFT : TOKEN_GOOGLE}`,
    ),
    false,
    "POST must not read the other signed-in mailbox",
  );
  if (host === "gmail.googleapis.com") {
    assert.ok(
      mailbox.some((call) => call.path === "/gmail/v1/users/me/messages"),
      `the inbox list must run. ${describe(result)}`,
    );
  }
  assert.ok(
    providerCalls(result).some((call) => call.path.includes(":generateContent")),
    `the model call must run for a bulk sender. ${describe(result)}`,
  );
  const modelCall = providerCalls(result).find((call) =>
    call.path.includes(":generateContent"),
  );
  assert.ok(modelCall, describe(result));
}

await assertAllowedPost(googleAccount.id, TOKEN_GOOGLE, "gmail.googleapis.com");
await assertAllowedPost(
  microsoftAccount.id,
  TOKEN_MICROSOFT,
  "graph.microsoft.com",
);

const sharedGets: Array<{
  name: string;
  handler: (request: Request, context?: unknown) => Promise<Response>;
  pathname: string;
  context?: unknown;
}> = [
  { name: "today", handler: todayRoute.GET, pathname: "/api/today" },
  { name: "mailbox", handler: mailboxRoute.GET, pathname: "/api/mailbox" },
  { name: "alltasks", handler: allTasksRoute.GET, pathname: "/api/alltasks" },
  { name: "catchup", handler: catchupRoute.GET, pathname: "/api/catchup" },
  {
    name: "classifier samples",
    handler: samplesRoute.GET,
    pathname: "/api/classifier/samples",
  },
  {
    name: "message",
    handler: messageRoute.GET,
    pathname: "/api/messages/m1",
    context: { params: Promise.resolve({ id: "m1" }) },
  },
];

for (const route of sharedGets) {
  const result = await invoke(
    route.handler,
    appRequest("GET", route.pathname, {
      secFetchSite: "cross-site",
      secFetchMode: "navigate",
    }),
    route.context,
  );
  assertRefusedBeforeSideEffects(
    result,
    `cross-site top-level GET /api/${route.name}`,
  );
}

const sameOriginToday = await invoke(
  todayRoute.GET,
  appRequest("GET", "/api/today", {
    origin: APP_ORIGIN,
    secFetchSite: "same-origin",
    secFetchMode: "cors",
  }),
);
assert.notEqual(sameOriginToday.status, 401, describe(sameOriginToday));
assert.notEqual(sameOriginToday.status, 403, describe(sameOriginToday));
assert.notEqual(sameOriginToday.status, 405, describe(sameOriginToday));
assert.ok(
  providerCalls(sameOriginToday).some((call) => call.host === "gmail.googleapis.com"),
  `a same-origin inbox load may still read the mailbox. ${describe(sameOriginToday)}`,
);

await db.stop();
console.log("unsub-agent-csrf: OK");

async function assertBrowserSendsLaxCookieOnNavigation() {
  const marker = "lax-marker";
  const laxCookie = defaultCookies(false).sessionToken;
  assert.equal(laxCookie.options.sameSite, "lax");
  assert.equal(sessionCookie.options.secure, true);
  const setCookie = serialize(laxCookie.name, marker, laxCookie.options);
  assert.match(setCookie, /samesite=lax/i);

  const seen: Record<string, string | undefined> = {};
  const hits = new Set<string>();
  let evilPort = 0;
  const seer = createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = req.url ?? "";
    hits.add(`${req.method} ${url}`);
    seen[`${req.method} ${url}`] = req.headers.cookie;
    const evil = `http://evil.test:${evilPort}`;
    if (url === "/set") {
      res.setHeader("set-cookie", setCookie);
      res.setHeader("content-type", "text/html");
      res.end(
        `<!doctype html><meta http-equiv="refresh" content="0;url=${evil}/go">`,
      );
      return;
    }
    res.end("ok");
  });
  await new Promise<void>((resolve) => seer.listen(0, "127.0.0.1", resolve));
  const seerPort = (seer.address() as { port: number }).port;
  const evil = createServer((req, res) => {
    const target = `http://seer.test:${seerPort}`;
    if (req.url === "/go") {
      res.setHeader("content-type", "text/html");
      res.end(`<!doctype html>
        <img src="${target}/subresource">
        <iframe name="postbox"></iframe>
        <form id="f" method="post" action="${target}/posted" target="postbox"></form>
        <script>
          document.getElementById("f").submit();
          setTimeout(function () { location.href = "${target}/navigated"; }, 50);
        </script>`);
      return;
    }
    res.end("idle");
  });
  await new Promise<void>((resolve) => evil.listen(0, "127.0.0.1", resolve));
  evilPort = (evil.address() as { port: number }).port;
  const profile = await mkdtemp(path.join(tmpdir(), "seer-chrome-"));
  const chrome = process.env.CHROME_BIN ?? "google-chrome";
  const rules = "MAP seer.test 127.0.0.1, MAP evil.test 127.0.0.1";

  async function browse(url: string) {
    const ready = () =>
      hits.has("GET /navigated") &&
      hits.has("GET /subresource") &&
      hits.has("POST /posted");
    await new Promise<void>((resolve, reject) => {
      const child = spawn(
        chrome,
        [
          "--headless=new",
          "--disable-gpu",
          "--no-sandbox",
          "--no-first-run",
          "--virtual-time-budget=10000",
          "--dump-dom",
          `--user-data-dir=${profile}`,
          `--host-resolver-rules=${rules}`,
          url,
        ],
        { stdio: "ignore" },
      );
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        reject(new Error(`chrome timed out; hits ${[...hits].join(",")}`));
      }, 15_000);
      const poll = setInterval(() => {
        if (!ready()) return;
        clearInterval(poll);
        clearTimeout(timer);
        child.kill("SIGKILL");
        resolve();
      }, 50);
      child.on("error", (error) => {
        clearInterval(poll);
        clearTimeout(timer);
        reject(error);
      });
    });
  }

  await browse(`http://seer.test:${seerPort}/set`);
  seer.close();
  evil.close();

  assert.equal(
    seen["GET /navigated"],
    `${laxCookie.name}=${marker}`,
    `a lax session cookie is attached to a cross-site top-level GET; saw ${JSON.stringify(seen)}`,
  );
  assert.equal(
    seen["GET /subresource"],
    undefined,
    "a lax session cookie is not attached to a cross-site image",
  );
  assert.equal(
    seen["POST /posted"],
    undefined,
    "a lax session cookie is not attached to a cross-site form POST",
  );
}
