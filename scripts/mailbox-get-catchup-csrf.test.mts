/**
 * Cross-site top-level GET must not start a mailbox provider catch-up.
 *
 * GET /api/v3/mailbox and GET /api/v2/inbox render the signed-in mailbox and,
 * while this bug is present, also schedule a provider head poll. The session
 * cookie Auth.js issues is SameSite=Lax, so a browser sends it on a top-level
 * navigation from another site. These tests open that navigation in Chrome
 * and require that neither route call Gmail or Microsoft Graph or store the
 * returned page.
 *
 * They fail while the catch-up still runs from those GETs, and pass once a
 * GET no longer starts it (including when the inbox is still backfilling and
 * when stored mail is older than the stale window).
 */
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import type { IncomingMessage, ServerResponse } from "node:http";
import https from "node:https";
import { createRequire } from "node:module";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

process.env.AUTH_SECRET = "placeholder-auth-secret";
process.env.NODE_ENV = "test";
delete process.env.AUTH_URL;
delete process.env.NEXTAUTH_URL;
delete process.env.NEXTAUTH_SECRET;
delete process.env.VERCEL;
delete process.env.VERCEL_ENV;

const require = createRequire(import.meta.url);
function loadModule<T>(relativePath: string): T {
  return require(fileURLToPath(new URL(relativePath, import.meta.url))) as T;
}
// Next's request storage uses global AsyncLocalStorage, which the Node server
// baseline installs. Loading it first keeps route handlers on the real store.
loadModule("../node_modules/next/dist/server/node-environment-baseline.js");
const { defaultCookies } = loadModule<typeof import("../node_modules/@auth/core/lib/utils/cookie.js")>(
  "../node_modules/@auth/core/lib/utils/cookie.js",
);
const { serialize } = loadModule<{
  serialize: (
    name: string,
    value: string,
    options: {
      httpOnly?: boolean;
      sameSite?: "lax" | "strict" | "none";
      path?: string;
      secure?: boolean;
    },
  ) => string;
}>("../node_modules/@auth/core/lib/vendored/cookie.js");
const { createWorkStore } = loadModule<{
  createWorkStore: (args: {
    page: string;
    renderOpts: Record<string, unknown>;
    isPrefetchRequest: boolean;
    buildId: string;
    previouslyRevalidatedTags: string[];
  }) => { afterContext: { onClose: (done: () => void) => void } };
}>("../node_modules/next/dist/server/async-storage/work-store.js");
const { createRequestStoreForAPI } = loadModule<{
  createRequestStoreForAPI: (
    req: IncomingMessage,
    url: { pathname: string; search: string },
    implicitTags: string[],
    onUpdateCookies: undefined,
    previewProps: undefined,
  ) => unknown;
}>("../node_modules/next/dist/server/async-storage/request-store.js");
const { workAsyncStorage } = loadModule<{
  workAsyncStorage: { run: <T>(store: unknown, fn: () => T) => T };
}>("../node_modules/next/dist/server/app-render/work-async-storage.external.js");
const { workUnitAsyncStorage } = loadModule<{
  workUnitAsyncStorage: { run: <T>(store: unknown, fn: () => T) => T };
}>("../node_modules/next/dist/server/app-render/work-unit-async-storage.external.js");

const { encode } = await import("@auth/core/jwt");
const { startTestDb } = await import("./v2-testdb.mts");
const { upsertUser, upsertAccount, saveCredentials } = await import(
  "../src/lib/v2/db/accounts.ts"
);
const mailboxRoute = await import("../src/app/api/v3/mailbox/route.ts");
const inboxRoute = await import("../src/app/api/v2/inbox/route.ts");

const sessionCookie = defaultCookies(true).sessionToken;
const VICTIM_HOST = "victim.example";
const ATTACKER_HOST = "attacker.example";

type ProviderName = "google" | "microsoft";

type AccountCase = {
  id: string;
  provider: ProviderName;
  email: string;
  threadId: string;
  messageId: string;
};

type Hit = {
  host: string;
  path: string;
  secFetchSite: string | null;
  secFetchMode: string | null;
  secFetchDest: string | null;
  origin: string | null;
  referer: string | null;
  cookieSent: boolean;
  status: number;
  catchingUp: boolean | null;
};

const providerCalls: { url: string; method: string }[] = [];
let activeCase: AccountCase | null = null;
const originalFetch = globalThis.fetch;

function headerValue(headers: IncomingMessage["headers"], name: string): string | null {
  const value = headers[name];
  if (Array.isArray(value)) return value.join(",");
  return value ?? null;
}

function gmailBody(messageId: string, threadId: string, email: string): unknown {
  return {
    id: threadId,
    messages: [
      {
        id: messageId,
        threadId,
        snippet: "arrived while away",
        labelIds: ["INBOX", "UNREAD"],
        internalDate: "1763600000000",
        payload: {
          mimeType: "text/plain",
          headers: [
            { name: "From", value: "sender@example.com" },
            { name: "To", value: email },
            { name: "Subject", value: "Fresh page" },
          ],
          body: { data: Buffer.from("hello").toString("base64url") },
        },
      },
    ],
  };
}

function graphMessage(messageId: string, threadId: string, email: string, withBody: boolean) {
  return {
    id: messageId,
    conversationId: threadId,
    subject: "Fresh page",
    from: { emailAddress: { address: "sender@example.com", name: "Sender" } },
    toRecipients: [{ emailAddress: { address: email } }],
    ccRecipients: [],
    receivedDateTime: "2026-11-20T00:00:00Z",
    bodyPreview: "arrived while away",
    isRead: false,
    ...(withBody
      ? { body: { contentType: "text", content: "hello" } }
      : {}),
  };
}

function providerResponse(url: string): Response {
  const current = activeCase;
  if (!current) {
    throw new Error(`provider fetch with no active mailbox case: ${url}`);
  }
  if (url.startsWith("https://gmail.googleapis.com/gmail/v1/users/me/threads?")) {
    return Response.json({
      threads: [{ id: current.threadId }],
      resultSizeEstimate: 1,
    });
  }
  if (url.startsWith(`https://gmail.googleapis.com/gmail/v1/users/me/threads/${current.threadId}`)) {
    return Response.json(gmailBody(current.messageId, current.threadId, current.email));
  }
  if (url.startsWith("https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages")) {
    return Response.json({
      value: [graphMessage(current.messageId, current.threadId, current.email, false)],
      "@odata.count": 1,
    });
  }
  if (url.startsWith("https://graph.microsoft.com/v1.0/me/messages?")) {
    return Response.json({
      value: [graphMessage(current.messageId, current.threadId, current.email, true)],
    });
  }
  if (url.includes("https://graph.microsoft.com/v1.0/me/mailFolders/")) {
    return Response.json({ totalItemCount: 1 });
  }
  throw new Error(`unexpected provider url: ${url}`);
}

globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
  const url =
    typeof input === "string"
      ? input
      : input instanceof URL
        ? input.toString()
        : input.url;
  const method = (init?.method ?? (typeof input === "object" && "method" in input ? input.method : "GET")).toUpperCase();
  if (
    url.startsWith("https://gmail.googleapis.com/") ||
    url.startsWith("https://graph.microsoft.com/") ||
    url.startsWith("https://oauth2.googleapis.com/") ||
    url.startsWith("https://login.microsoftonline.com/")
  ) {
    providerCalls.push({ url, method });
    if (
      url.startsWith("https://oauth2.googleapis.com/") ||
      url.startsWith("https://login.microsoftonline.com/")
    ) {
      throw new Error(`token endpoint must not be called by a mailbox read: ${new URL(url).origin}`);
    }
    return providerResponse(url);
  }
  return originalFetch(input, init);
};

async function sessionCookieHeader(account: AccountCase): Promise<string> {
  const token = await encode({
    salt: sessionCookie.name,
    secret: process.env.AUTH_SECRET,
    token: {
      email: account.email,
      activeAccountId: account.id,
      provider: account.provider === "google" ? "google" : "microsoft-entra-id",
    },
  });
  return serialize(sessionCookie.name, token, sessionCookie.options);
}

async function invokeRoute(req: IncomingMessage, pathname: string): Promise<{ status: number; body: string }> {
  const handler = pathname.startsWith("/api/v3/mailbox") ? mailboxRoute.GET : inboxRoute.GET;
  const pending: Promise<unknown>[] = [];
  let releaseClose = () => {};
  const workStore = createWorkStore({
    page: pathname,
    isPrefetchRequest: false,
    buildId: "test",
    previouslyRevalidatedTags: [],
    renderOpts: {
      supportsDynamicResponse: true,
      experimental: {},
      waitUntil(promise: Promise<unknown>) {
        pending.push(promise);
      },
      onClose(done: () => void) {
        releaseClose = done;
      },
      onAfterTaskError(error: unknown) {
        console.error("[after-task]", error instanceof Error ? error.message : error);
      },
    },
  });
  const requestUrl = new URL(req.url ?? pathname, `https://${headerValue(req.headers, "host") ?? VICTIM_HOST}`);
  const requestStore = createRequestStoreForAPI(
    req,
    { pathname: requestUrl.pathname, search: requestUrl.search },
    [],
    undefined,
    undefined,
  );
  const request = new Request(requestUrl, { method: "GET", headers: headersFromNode(req.headers) });
  return workAsyncStorage.run(workStore, () =>
    workUnitAsyncStorage.run(requestStore, async () => {
      const response = await handler(request);
      const body = await response.text();
      releaseClose();
      await Promise.all(pending);
      return { status: response.status, body };
    }),
  );
}

function headersFromNode(headers: IncomingMessage["headers"]): Headers {
  const out = new Headers();
  for (const [name, value] of Object.entries(headers)) {
    if (value == null) continue;
    if (Array.isArray(value)) {
      for (const item of value) out.append(name, item);
    } else {
      out.set(name, value);
    }
  }
  return out;
}

function installCertificate(dir: string): { key: string; cert: string } {
  const key = path.join(dir, "key.pem");
  const cert = path.join(dir, "cert.pem");
  execFileSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-keyout",
      key,
      "-out",
      cert,
      "-days",
      "1",
      "-nodes",
      "-subj",
      `/CN=${VICTIM_HOST}`,
      "-addext",
      `subjectAltName=DNS:${VICTIM_HOST},DNS:${ATTACKER_HOST}`,
    ],
    { stdio: "pipe" },
  );
  return { key, cert };
}

async function launchChrome(userDataDir: string, debugPort: number): Promise<ChildProcess> {
  const chrome = spawn(
    "google-chrome",
    [
      "--headless=new",
      "--disable-gpu",
      "--no-sandbox",
      "--disable-dev-shm-usage",
      "--no-first-run",
      "--no-default-browser-check",
      `--user-data-dir=${userDataDir}`,
      `--remote-debugging-port=${debugPort}`,
      `--host-resolver-rules=MAP ${VICTIM_HOST} 127.0.0.1, MAP ${ATTACKER_HOST} 127.0.0.1`,
      "--ignore-certificate-errors",
      "about:blank",
    ],
    { stdio: "ignore" },
  );
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    try {
      const version = await originalFetch(`http://127.0.0.1:${debugPort}/json/version`);
      if (version.ok) return chrome;
    } catch {
      // Chrome is still binding the debugging port.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  chrome.kill("SIGKILL");
  throw new Error("Chrome did not open a debugging port");
}

async function settleProviderWork(): Promise<void> {
  // The route schedules catch-up with `void work()` inside after(), so the
  // provider call keeps running after the response callback returns.
  let stable = 0;
  let seen = providerCalls.length;
  while (stable < 5) {
    await new Promise((resolve) => setTimeout(resolve, 20));
    if (providerCalls.length === seen) stable += 1;
    else {
      seen = providerCalls.length;
      stable = 0;
    }
  }
}

async function browse(debugPort: number, url: string, seen: () => boolean): Promise<void> {
  let opened = await originalFetch(
    `http://127.0.0.1:${debugPort}/json/new?${encodeURIComponent(url)}`,
    { method: "PUT" },
  );
  if (!opened.ok) {
    opened = await originalFetch(
      `http://127.0.0.1:${debugPort}/json/new?${encodeURIComponent(url)}`,
    );
  }
  if (!opened.ok) {
    throw new Error(`Chrome did not open a tab (${opened.status})`);
  }
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (seen()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  const tabs = await originalFetch(`http://127.0.0.1:${debugPort}/json/list`).then((response) => response.text());
  throw new Error(`Chrome did not reach the mailbox route. Open tabs: ${tabs.slice(0, 1500)}`);
}

const failures: string[] = [];

function expect(condition: unknown, message: string) {
  if (!condition) failures.push(message);
}

const db = await startTestDb();
const scratch = await mkdtemp(path.join(tmpdir(), "seer-csrf-"));
const chromePort = 9300 + Math.floor(Math.random() * 500);
let chrome: ChildProcess | null = null;
let server: https.Server | null = null;

try {
  const googleUser = await upsertUser("desk-google@rditrials.com");
  const googleId = await upsertAccount({
    userId: googleUser,
    provider: "google",
    email: "desk-google@rditrials.com",
    displayName: "Desk Google",
  });
  await saveCredentials(googleId, "google", {
    accessToken: "placeholder-access-token",
    expiresAt: Date.now() + 60 * 60 * 1000,
  });
  const google: AccountCase = {
    id: googleId,
    provider: "google",
    email: "desk-google@rditrials.com",
    threadId: "thread-fresh-gmail",
    messageId: "msg-fresh-gmail",
  };

  const microsoftUser = await upsertUser("desk-microsoft@rditrials.com");
  const microsoftId = await upsertAccount({
    userId: microsoftUser,
    provider: "microsoft",
    email: "desk-microsoft@rditrials.com",
    displayName: "Desk Microsoft",
  });
  await saveCredentials(microsoftId, "microsoft", {
    accessToken: "placeholder-access-token",
    expiresAt: Date.now() + 60 * 60 * 1000,
  });
  await db.pool.query(
    `insert into seer.folder_sync_state (account_id, folder, backfill_complete, provider_total)
     values ($1, 'inbox', true, 1)`,
    [microsoftId],
  );
  await db.pool.query(
    `insert into seer.conversations
       (account_id, provider_conversation_id, subject, last_message_at, message_count, folders, last_synced_at)
     values ($1, 'old-thread', 'old', now() - interval '20 minutes', 1, '{inbox}', now() - interval '20 minutes')`,
    [microsoftId],
  );
  const microsoft: AccountCase = {
    id: microsoftId,
    provider: "microsoft",
    email: "desk-microsoft@rditrials.com",
    threadId: "conv-fresh-graph",
    messageId: "msg-fresh-graph",
  };

  const cookies = new Map<string, string>([
    [google.email, await sessionCookieHeader(google)],
    [microsoft.email, await sessionCookieHeader(microsoft)],
  ]);
  const hits: Hit[] = [];
  const requests: string[] = [];
  const { key, cert } = installCertificate(scratch);
  server = https.createServer(
    { key: await readFile(key), cert: await readFile(cert) },
    async (req, res) => {
      try {
        await handle(req, res);
      } catch (error) {
        console.error(error);
        if (!res.headersSent) res.statusCode = 500;
        res.end(error instanceof Error ? error.message : "error");
      }
    },
  );
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("test server has no port");
  const port = address.port;

  async function handle(req: IncomingMessage, res: ServerResponse) {
    const host = headerValue(req.headers, "host")?.split(":")[0] ?? "";
    const url = new URL(req.url ?? "/", `https://${host}`);
    requests.push(`${host}${url.pathname}`);
    if (host === ATTACKER_HOST) {
      const to = url.searchParams.get("to");
      if (!to) {
        res.statusCode = 400;
        res.end("missing redirect target");
        return;
      }
      res.statusCode = 200;
      res.setHeader("content-type", "text/html; charset=utf-8");
      res.setHeader("cache-control", "no-store");
      res.end(`<!doctype html><script>location.assign(${JSON.stringify(to)})</script>`);
      return;
    }
    if (url.pathname === "/establish") {
      const email = url.searchParams.get("email");
      const cookie = email ? cookies.get(email) : undefined;
      if (!cookie) {
        res.statusCode = 400;
        res.end("missing session");
        return;
      }
      res.statusCode = 200;
      res.setHeader("set-cookie", cookie);
      res.setHeader("cache-control", "no-store");
      res.end("ready");
      hits.push({
        host,
        path: url.pathname,
        secFetchSite: headerValue(req.headers, "sec-fetch-site"),
        secFetchMode: headerValue(req.headers, "sec-fetch-mode"),
        secFetchDest: headerValue(req.headers, "sec-fetch-dest"),
        origin: headerValue(req.headers, "origin"),
        referer: headerValue(req.headers, "referer"),
        cookieSent: false,
        status: 200,
        catchingUp: null,
      });
      return;
    }
    if (url.pathname !== "/api/v3/mailbox" && url.pathname !== "/api/v2/inbox") {
      res.statusCode = 404;
      res.end("not found");
      return;
    }
    const callsBefore = providerCalls.length;
    const result = await invokeRoute(req, url.pathname);
    const calls = providerCalls.slice(callsBefore);
    let catchingUp: boolean | null = null;
    try {
      catchingUp = Boolean(JSON.parse(result.body).catchingUp);
    } catch {
      catchingUp = null;
    }
    const cookieHeader = headerValue(req.headers, "cookie") ?? "";
    hits.push({
      host,
      path: url.pathname,
      secFetchSite: headerValue(req.headers, "sec-fetch-site"),
      secFetchMode: headerValue(req.headers, "sec-fetch-mode"),
      secFetchDest: headerValue(req.headers, "sec-fetch-dest"),
      origin: headerValue(req.headers, "origin"),
      referer: headerValue(req.headers, "referer"),
      cookieSent: cookieHeader.includes(`${sessionCookie.name}=`),
      status: result.status,
      catchingUp,
    });
    if (calls.length > 0 && result.status === 404) {
      throw new Error("provider was called for an anonymous response");
    }
    res.statusCode = result.status;
    res.setHeader("content-type", "application/json");
    res.end(result.body);
  }

  chrome = await launchChrome(path.join(scratch, "chrome"), chromePort);

  async function stored(account: AccountCase): Promise<number> {
    const result = await db.pool.query<{ n: number }>(
      `select count(*)::int as n
         from seer.messages
        where account_id = $1 and provider_message_id = $2`,
      [account.id, account.messageId],
    );
    return result.rows[0].n;
  }

  async function crossSiteGet(account: AccountCase, pathname: "/api/v3/mailbox" | "/api/v2/inbox") {
    activeCase = account;
    const beforeCalls = providerCalls.length;
    const beforeStored = await stored(account);
    const api = `https://${VICTIM_HOST}:${port}${pathname}`;
    const establish = `https://${VICTIM_HOST}:${port}/establish?email=${encodeURIComponent(account.email)}`;
    const attack = `https://${ATTACKER_HOST}:${port}/go?to=${encodeURIComponent(api)}`;
    const established = hits.length;
    try {
      await browse(chromePort, establish, () => hits.length > established);
    } catch (error) {
      throw new Error(
        `${error instanceof Error ? error.message : error}\nserver saw: ${requests.join(" ")}`,
      );
    }
    const hitCount = hits.length;
    try {
      await browse(chromePort, attack, () => hits.length > hitCount);
    } catch (error) {
      throw new Error(
        `${error instanceof Error ? error.message : error}\nserver saw: ${requests.join(" ")}`,
      );
    }
    const hit = hits[hits.length - 1];
    await settleProviderWork();
    const calls = providerCalls.slice(beforeCalls).map((call) => `${call.method} ${call.url}`);
    const afterStored = await stored(account);
    const label = `${pathname} ${account.provider}`;
    expect(hit?.host === VICTIM_HOST, `${label}: navigation did not reach the mailbox host`);
    expect(hit?.path === pathname, `${label}: navigation did not request ${pathname}`);
    expect(
      hit?.secFetchSite === "cross-site",
      `${label}: browser did not classify the navigation as cross-site (sec-fetch-site=${hit?.secFetchSite ?? "missing"})`,
    );
    expect(
      hit?.secFetchMode === "navigate",
      `${label}: browser did not send a top-level navigation (sec-fetch-mode=${hit?.secFetchMode ?? "missing"})`,
    );
    expect(
      hit?.cookieSent === true,
      `${label}: browser did not send the SameSite=Lax session cookie on the cross-site navigation`,
    );
    expect(
      hit?.status !== 404,
      `${label}: signed-in session was not accepted (status ${hit?.status})`,
    );
    expect(
      calls.length === 0,
      `${label}: cross-site GET called the provider (sec-fetch-site=${hit?.secFetchSite}, sec-fetch-mode=${hit?.secFetchMode}, cookie sent=${hit?.cookieSent}):\n${calls.join("\n")}`,
    );
    expect(
      afterStored === beforeStored,
      `${label}: cross-site GET stored ${afterStored - beforeStored} new provider message(s)`,
    );
    expect(
      !(hit?.catchingUp === true && calls.length === 0),
      `${label}: catch-up was reported but the scheduled provider work did not run`,
    );
  }

  await crossSiteGet(google, "/api/v3/mailbox");
  await crossSiteGet(microsoft, "/api/v2/inbox");
  await settleProviderWork();
} finally {
  if (failures.length > 0) {
    console.error(failures.map((failure) => `- ${failure}`).join("\n"));
  }
  globalThis.fetch = originalFetch;
  chrome?.kill("SIGKILL");
  if (server) {
    await new Promise<void>((resolve) => server!.close(() => resolve()));
  }
  db.pool.on("error", () => {});
  try {
    await db.stop();
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
  }
  await rm(scratch, { recursive: true, force: true });
}

if (failures.length > 0) process.exit(1);
console.log("mailbox-get-catchup-csrf: OK");

