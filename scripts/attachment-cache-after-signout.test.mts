/**
 * Opened attachments must not stay readable from the browser's HTTP cache or
 * back-forward history after the mailbox session is gone.
 *
 * These tests fail while a successful download is stored with a positive
 * max-age. They pass once that response cannot be reused after sign-out.
 */
import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { encode } from "@auth/core/jwt";

// Next's request storage uses globalThis.AsyncLocalStorage, which its server
// installs before route handlers run. A plain test process has to do the same
// before the first import of next/dist.
const asyncLocalStorageGlobal = globalThis as typeof globalThis & {
  AsyncLocalStorage?: typeof AsyncLocalStorage;
};
asyncLocalStorageGlobal.AsyncLocalStorage ??= AsyncLocalStorage;

process.env.NODE_ENV = "development";
delete process.env.AUTH_URL;
delete process.env.NEXTAUTH_URL;
process.env.AUTH_SECRET = "attachment-cache-test-auth-secret";
process.env.AUTH_TRUST_HOST = "true";

const { startTestDb } = await import("./v2-testdb.mts");
const { upsertUser, upsertAccountWithCredentials } = await import(
  "../src/lib/v2/db/accounts.ts"
);
const { attachmentUrl } = await import("../src/components/v2/Reader.tsx");
const { GET: getV3Attachment } = await import(
  "../src/app/api/v3/messages/[id]/attachments/[attachmentId]/route.ts"
);
const { GET: getLegacyAttachment } = await import(
  "../src/app/api/messages/[id]/attachment/route.ts"
);
const { createWorkStore } = await import(
  "next/dist/server/async-storage/work-store.js"
);
const { createRequestStoreForAPI } = await import(
  "next/dist/server/async-storage/request-store.js"
);
const { workAsyncStorage } = await import(
  "next/dist/server/app-render/work-async-storage.external.js"
);
const { workUnitAsyncStorage } = await import(
  "next/dist/server/app-render/work-unit-async-storage.external.js"
);

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SECRET = "mailbox-file-body-7c2e";
const OTHER_BODY = "other-mailbox-body";
const MESSAGE_ID = "msg-contract";
const ATTACHMENT_ID = `${MESSAGE_ID}-0`;
const THREAD_ID = "thread-contract";
const GMAIL_ATTACHMENT_ID = "att-real";
const SESSION_COOKIE = "authjs.session-token";
const ACTIVE_COOKIE = "seer_active_account";
const OWNER_EMAIL = "cache-owner@rditrials.com";
const OTHER_EMAIL = "cache-other@rditrials.com";
const OWNER_TOKEN = "provider-access-placeholder-owner";
const OTHER_TOKEN = "provider-access-placeholder-other";

const swSource = readFileSync(path.join(HERE, "../public/sw.js"), "utf8");

type Handler = (
  request: Request,
  context: { params: Promise<Record<string, string>> },
) => Promise<Response>;

function bearer(input: RequestInfo | URL, init?: RequestInit): string {
  const headers = new Headers(
    typeof input === "object" && input !== null && "headers" in input
      ? (input as Request).headers
      : undefined,
  );
  if (init?.headers) {
    new Headers(init.headers).forEach((value, key) => headers.set(key, value));
  }
  const header = headers.get("authorization") ?? "";
  return header.replace(/^Bearer\s+/i, "");
}

function gmailMessage() {
  return {
    id: MESSAGE_ID,
    threadId: THREAD_ID,
    internalDate: String(Date.parse("2026-08-09T10:00:00Z")),
    snippet: "see attached",
    labelIds: [],
    payload: {
      mimeType: "multipart/mixed",
      headers: [
        { name: "From", value: "alice@example.com" },
        { name: "To", value: OWNER_EMAIL },
        { name: "Subject", value: "Contract" },
      ],
      parts: [
        {
          mimeType: "text/plain",
          filename: "contract.txt",
          body: { attachmentId: GMAIL_ATTACHMENT_ID, size: SECRET.length },
        },
      ],
    },
  };
}

let providerCalls = 0;
const realFetch = globalThis.fetch.bind(globalThis);
globalThis.fetch = async (input, init) => {
  const url =
    typeof input === "string"
      ? input
      : input instanceof URL
        ? input.href
        : input.url;
  if (!url.startsWith("https://gmail.googleapis.com/")) {
    return realFetch(input, init);
  }
  providerCalls += 1;
  const token = bearer(input, init);
  const owned = token === OWNER_TOKEN;
  if (url.includes(`/attachments/${GMAIL_ATTACHMENT_ID}`)) {
    const body = owned ? SECRET : OTHER_BODY;
    return Response.json({
      data: Buffer.from(body).toString("base64"),
      size: body.length,
    });
  }
  if (url.includes(`/threads/${THREAD_ID}`)) {
    return Response.json({ id: THREAD_ID, messages: [gmailMessage()] });
  }
  if (url.includes(`/messages/${MESSAGE_ID}`)) {
    return Response.json(gmailMessage());
  }
  return new Response("not found", { status: 404 });
};

function withBrowserCookies<T>(cookieHeader: string, run: () => Promise<T>): Promise<T> {
  const headers = new Headers({
    cookie: cookieHeader,
    host: "127.0.0.1",
    "x-forwarded-proto": "http",
  });
  const workStore = createWorkStore({
    page: "/api/v3/messages/[id]/attachments/[attachmentId]",
    renderOpts: {
      supportsDynamicResponse: true,
      shouldWaitOnAllReady: true,
      experimental: {},
    },
    isPrefetchRequest: false,
    buildId: "attachment-cache-test",
    previouslyRevalidatedTags: [],
  });
  const requestStore = createRequestStoreForAPI(
    { headers },
    new URL("http://127.0.0.1/"),
    [],
    undefined,
    undefined,
  );
  return workAsyncStorage.run(workStore, () =>
    workUnitAsyncStorage.run(requestStore, run),
  );
}

async function sessionCookie(email: string, accountId: string): Promise<string> {
  const token = await encode({
    salt: SESSION_COOKIE,
    secret: process.env.AUTH_SECRET!,
    token: {
      email,
      sub: email,
      provider: "google",
      activeAccountId: accountId,
    },
  });
  return token;
}

function cookieHeader(session: string, accountId: string): string {
  return `${SESSION_COOKIE}=${session}; ${ACTIVE_COOKIE}=${accountId}`;
}

async function invoke(
  handler: Handler,
  cookieHeaderValue: string,
  url: string,
  params: Record<string, string>,
): Promise<Response> {
  return withBrowserCookies(cookieHeaderValue, () =>
    handler(new Request(url), { params: Promise.resolve(params) }),
  );
}

const db = await startTestDb();
const chrome = { proc: null as ReturnType<typeof spawn> | null, profile: "" };
const server = http.createServer();

try {
  const ownerId = await upsertUser(OWNER_EMAIL);
  const owner = await upsertAccountWithCredentials({
    userId: ownerId,
    provider: "google",
    email: OWNER_EMAIL,
    displayName: "Cache Owner",
    accessToken: OWNER_TOKEN,
    expiresAt: Date.now() + 60 * 60 * 1000,
  });
  const otherId = await upsertUser(OTHER_EMAIL);
  const other = await upsertAccountWithCredentials({
    userId: otherId,
    provider: "google",
    email: OTHER_EMAIL,
    displayName: "Cache Other",
    accessToken: OTHER_TOKEN,
    expiresAt: Date.now() + 60 * 60 * 1000,
  });
  await db.pool.query(
    `insert into seer.conversations
       (account_id, provider_conversation_id, subject, last_message_at, folders, is_unread)
     values ($1, $2, 'Contract', '2026-08-09T10:00:00Z', array['inbox']::text[], false)`,
    [owner.id, THREAD_ID],
  );
  const conversation = await db.pool.query<{ id: string }>(
    `select id from seer.conversations where account_id = $1 and provider_conversation_id = $2`,
    [owner.id, THREAD_ID],
  );
  await db.pool.query(
    `insert into seer.messages
       (account_id, conversation_id, provider_message_id, from_email, from_name,
        to_emails, sent_at, snippet, body_text, is_unread, is_outgoing, attachment_names)
     values ($1, $2, $3, 'alice@example.com', 'Alice', $4, '2026-08-09T10:00:00Z',
             'see attached', 'see attached', false, false, array['contract.txt'])`,
    [owner.id, conversation.rows[0].id, MESSAGE_ID, [OWNER_EMAIL]],
  );

  const ownerSession = await sessionCookie(OWNER_EMAIL, owner.id);
  const otherSession = await sessionCookie(OTHER_EMAIL, other.id);
  const v3Path = attachmentUrl(MESSAGE_ID, ATTACHMENT_ID);
  assert.equal(
    v3Path,
    `/api/v3/messages/${MESSAGE_ID}/attachments/${ATTACHMENT_ID}`,
  );
  const legacyPath =
    `/api/messages/${encodeURIComponent(MESSAGE_ID)}/attachment` +
    `?aid=${encodeURIComponent(GMAIL_ATTACHMENT_ID)}` +
    `&name=${encodeURIComponent("contract.txt")}` +
    `&type=${encodeURIComponent("text/plain")}`;

  const signedOutV3 = await invoke(
    getV3Attachment,
    "",
    `http://127.0.0.1${v3Path}`,
    { id: MESSAGE_ID, attachmentId: ATTACHMENT_ID },
  );
  assert.notEqual(signedOutV3.status, 200);
  assert.equal((await signedOutV3.text()).includes(SECRET), false);

  const callsBeforeOther = providerCalls;
  const otherV3 = await invoke(
    getV3Attachment,
    cookieHeader(otherSession, other.id),
    `http://127.0.0.1${v3Path}`,
    { id: MESSAGE_ID, attachmentId: ATTACHMENT_ID },
  );
  assert.equal(providerCalls, callsBeforeOther);
  assert.equal((await otherV3.text()).includes(SECRET), false);

  const opened = await invoke(
    getV3Attachment,
    cookieHeader(ownerSession, owner.id),
    `http://127.0.0.1${v3Path}`,
    { id: MESSAGE_ID, attachmentId: ATTACHMENT_ID },
  );
  assert.equal(opened.status, 200);
  assert.equal(await opened.text(), SECRET);

  let v3Hits = 0;
  let legacyHits = 0;

  async function writeHandler(
    nodeRes: http.ServerResponse,
    response: Response,
  ): Promise<void> {
    const body = Buffer.from(await response.arrayBuffer());
    const headers = new Map<string, string>();
    response.headers.forEach((value, key) => {
      if (key === "set-cookie") return;
      headers.set(key, value);
    });
    nodeRes.writeHead(response.status, Object.fromEntries(headers));
    nodeRes.end(body);
  }

  server.on("request", async (req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    try {
      if (url.pathname === "/sw.js") {
        res.writeHead(200, {
          "content-type": "application/javascript; charset=utf-8",
          "cache-control": "private, no-store",
          "service-worker-allowed": "/",
        });
        res.end(swSource);
        return;
      }
      if (
        [
          "/manifest.webmanifest",
          "/manifest.mobile.webmanifest",
          "/seer-eye.png",
          "/icons/icon-192.png",
          "/icons/icon-512.png",
        ].includes(url.pathname)
      ) {
        res.writeHead(200, {
          "content-type": "text/plain",
          "cache-control": "private, no-store",
        });
        res.end("icon");
        return;
      }
      if (url.pathname === "/reader" || url.pathname === "/legacy-reader" || url.pathname === "/as-other") {
        const session = url.pathname === "/as-other" ? otherSession : ownerSession;
        const accountId = url.pathname === "/as-other" ? other.id : owner.id;
        const href = url.pathname === "/legacy-reader" ? legacyPath : v3Path;
        res.writeHead(200, [
          ["content-type", "text/html; charset=utf-8"],
          ["cache-control", "private, no-store"],
          [
            "set-cookie",
            `${SESSION_COOKIE}=${session}; Path=/; HttpOnly; SameSite=Lax`,
          ],
          [
            "set-cookie",
            `${ACTIVE_COOKIE}=${accountId}; Path=/; HttpOnly; SameSite=Lax`,
          ],
        ]);
        res.end(
          `<!doctype html><a class="reader-file" href="${href}">contract.txt</a>`,
        );
        return;
      }
      if (url.pathname === "/sign-out") {
        res.writeHead(200, [
          ["content-type", "text/html; charset=utf-8"],
          ["cache-control", "private, no-store"],
          [
            "set-cookie",
            `${SESSION_COOKIE}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax`,
          ],
          [
            "set-cookie",
            `${ACTIVE_COOKIE}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax`,
          ],
        ]);
        res.end("<p>signed-out</p>");
        return;
      }
      if (url.pathname === `/api/v3/messages/${MESSAGE_ID}/attachments/${ATTACHMENT_ID}`) {
        v3Hits += 1;
        const response = await invoke(
          getV3Attachment,
          req.headers.cookie ?? "",
          `http://127.0.0.1${url.pathname}`,
          { id: MESSAGE_ID, attachmentId: ATTACHMENT_ID },
        );
        await writeHandler(res, response);
        return;
      }
      if (url.pathname === `/api/messages/${MESSAGE_ID}/attachment`) {
        legacyHits += 1;
        const response = await invoke(
          getLegacyAttachment,
          req.headers.cookie ?? "",
          `http://127.0.0.1${url.pathname}${url.search}`,
          { id: MESSAGE_ID },
        );
        await writeHandler(res, response);
        return;
      }
      res.writeHead(404, { "cache-control": "private, no-store" });
      res.end("missing");
    } catch (error) {
      res.writeHead(500, { "content-type": "text/plain", "cache-control": "private, no-store" });
      res.end(error instanceof Error ? error.stack ?? error.message : "failed");
    }
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no port");
  const origin = `http://127.0.0.1:${address.port}`;

  const debugPort = await new Promise<number>((resolve, reject) => {
    const probe = http.createServer();
    probe.listen(0, "127.0.0.1", () => {
      const info = probe.address();
      if (!info || typeof info === "string") {
        reject(new Error("no debug port"));
        return;
      }
      probe.close(() => resolve(info.port));
    });
  });
  chrome.profile = await mkdtemp(path.join(os.tmpdir(), "attachment-cache-"));
  chrome.proc = spawn(
    "google-chrome",
    [
      "--headless=new",
      `--remote-debugging-port=${debugPort}`,
      `--user-data-dir=${chrome.profile}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-gpu",
      "--disable-extensions",
      "about:blank",
    ],
    { stdio: "ignore" },
  );

  let wsUrl = "";
  for (let attempt = 0; attempt < 50; attempt++) {
    try {
      const list = (await fetch(`http://127.0.0.1:${debugPort}/json/list`).then((r) =>
        r.json(),
      )) as { type: string; webSocketDebuggerUrl: string }[];
      const page = list.find((entry) => entry.type === "page");
      if (page) {
        wsUrl = page.webSocketDebuggerUrl;
        break;
      }
    } catch {
      // Chrome is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  if (!wsUrl) throw new Error("Chrome did not open a debugging port");

  const ws = new WebSocket(wsUrl);
  await new Promise<void>((resolve, reject) => {
    ws.addEventListener("open", () => resolve());
    ws.addEventListener("error", () => reject(new Error("Chrome socket failed")));
  });
  let rpc = 0;
  const pending = new Map<number, (message: { result?: { result?: { value?: string } } }) => void>();
  const loads: Array<() => void> = [];
  ws.addEventListener("message", (event) => {
    const message = JSON.parse(String(event.data)) as {
      id?: number;
      method?: string;
      result?: { result?: { value?: string } };
    };
    if (message.id && pending.has(message.id)) {
      pending.get(message.id)!(message);
      pending.delete(message.id);
    }
    if (message.method === "Page.loadEventFired") {
      loads.splice(0).forEach((resolve) => resolve());
    }
  });
  function send(method: string, params: Record<string, unknown> = {}) {
    const id = ++rpc;
    ws.send(JSON.stringify({ id, method, params }));
    return new Promise<{ result?: { result?: { value?: string } } }>((resolve) => {
      pending.set(id, resolve);
    });
  }
  async function pageText(): Promise<string> {
    const result = await send("Runtime.evaluate", {
      expression: "document.body ? document.body.innerText : ''",
      returnByValue: true,
    });
    return result.result?.result?.value ?? "";
  }
  function waitForLoad(timeoutMs = 8000): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, timeoutMs);
      loads.push(() => {
        clearTimeout(timer);
        resolve();
      });
    });
  }
  async function go(url: string): Promise<string> {
    const loaded = waitForLoad();
    await send("Page.navigate", { url });
    await loaded;
    return pageText();
  }
  async function clickFile(): Promise<string> {
    const before = await pageText();
    const loaded = waitForLoad();
    await send("Runtime.evaluate", {
      expression: "document.querySelector('a.reader-file').click()",
      returnByValue: true,
    });
    await loaded;
    const start = Date.now();
    let text = await pageText();
    while (text === before && Date.now() - start < 3000) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      text = await pageText();
    }
    return text;
  }
  async function back(): Promise<string> {
    const before = await pageText();
    const loaded = waitForLoad(1500);
    await send("Runtime.evaluate", { expression: "history.back()", returnByValue: true });
    await loaded;
    const start = Date.now();
    let text = await pageText();
    while (text === before && Date.now() - start < 1500) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      text = await pageText();
    }
    return text;
  }

  await send("Page.enable");
  await send("Network.enable");
  await go(`${origin}/reader`);
  await send("Runtime.evaluate", {
    expression: `navigator.serviceWorker.register('/sw.js', { scope: '/', updateViaCache: 'none' }).then(() => navigator.serviceWorker.ready)`,
    awaitPromise: true,
    returnByValue: true,
  });
  await go(`${origin}/reader`);
  const controlled = await send("Runtime.evaluate", {
    expression: "Boolean(navigator.serviceWorker.controller)",
    returnByValue: true,
  });
  assert.equal(controlled.result?.result?.value, true);

  const results: { name: string; ok: boolean; detail: string }[] = [];
  function check(name: string, ok: boolean, detail: string) {
    results.push({ name, ok, detail });
  }

  async function reopen(label: string, readerPath: string, filePath: string, hits: () => number) {
    const openedText = await (async () => {
      await go(`${origin}${readerPath}`);
      return clickFile();
    })();
    const hitsAfterOpen = hits();
    check(
      `${label} signed-in download returns the file`,
      openedText.includes(SECRET) && hitsAfterOpen >= 1,
      `text=${openedText.slice(0, 80)} hits=${hitsAfterOpen}`,
    );
    await go(`${origin}/sign-out`);
    const hitsAfterSignOut = hits();
    const backed = await back();
    check(
      `${label} back button after sign-out does not show the file`,
      !backed.includes(SECRET),
      `text=${backed.slice(0, 120)} hits=${hits()}`,
    );
    const reopened = await go(`${origin}${filePath}`);
    check(
      `${label} history URL after sign-out asks the server and hides the file`,
      !reopened.includes(SECRET) && hits() > hitsAfterSignOut,
      `text=${reopened.slice(0, 120)} hits=${hits()} afterSignOut=${hitsAfterSignOut}`,
    );
    await go(`${origin}/as-other`);
    const asOther = await go(`${origin}${filePath}`);
    check(
      `${label} next signed-in mailbox does not receive the cached file`,
      !asOther.includes(SECRET),
      `text=${asOther.slice(0, 120)} hits=${hits()}`,
    );
  }

  await reopen("v3", "/reader", v3Path, () => v3Hits);
  await reopen("legacy", "/legacy-reader", legacyPath, () => legacyHits);

  ws.close();
  const failed = results.filter((result) => !result.ok);
  for (const result of results) {
    console.log(`${result.ok ? "PASS" : "FAIL"} ${result.name}: ${result.detail}`);
  }
  assert.equal(failed.length, 0, failed.map((result) => result.name).join("; "));
  console.log("attachment-cache-after-signout: OK");
} finally {
  server.close();
  if (chrome.proc) {
    chrome.proc.kill("SIGKILL");
    await new Promise((resolve) => chrome.proc?.once("exit", resolve));
  }
  if (chrome.profile) {
    await rm(chrome.profile, { recursive: true, force: true }).catch(() => {});
  }
  await db.stop();
}
