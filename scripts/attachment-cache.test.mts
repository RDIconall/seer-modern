/**
 * Authenticated attachment downloads must not stay readable from the browser
 * cache after the session cookie is gone.
 *
 * The handlers are the real route modules. Mailbox I/O is stubbed. The
 * response is written with Next.js 15.5.23 sendResponse, which is what an app
 * route uses for a dynamic GET. Chrome then performs the same top-level
 * navigation the mail UI's <a href> does.
 *
 * These assertions fail while a fresh Cache-Control max-age lets Chrome replay
 * the file with no new request. They pass once a signed-out navigation has to
 * hit the handler again and the handler refuses it.
 */
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import http from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { register } from "node:module";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import React, { createElement } from "react";
import { renderToString } from "react-dom/server";
import { AssistBar } from "../src/components/inbox/AssistBar.tsx";
import { LegacyThread } from "../src/components/mail/LegacyThread.tsx";
import { Reader, attachmentUrl } from "../src/components/v2/Reader.tsx";
import type { ReaderMessage } from "../src/lib/inbox/types.ts";
import type { Conversation } from "../src/lib/v2/providers/types.ts";
import { sendResponse } from "next/dist/server/send-response.js";
import { NodeNextRequest, NodeNextResponse } from "next/dist/server/base-http/node.js";
import {
  attachmentCacheAls,
  attachmentCacheState,
} from "./attachment-cache-state.ts";

const MARKER = "INVOICE-BODY-7f3a9c";

register(new URL("./attachment-cache-hook.mjs", import.meta.url));

const legacyRoute = await import("../src/app/api/messages/[id]/attachment/route.ts");
const v3Route = await import(
  "../src/app/api/v3/messages/[id]/attachments/[attachmentId]/route.ts"
);

type RouteGet = (
  request: Request,
  context: { params: Promise<Record<string, string>> },
) => Promise<Response>;

const failures: string[] = [];

function check(name: string, fn: () => void): void {
  try {
    fn();
    console.log(`  ok   ${name}`);
  } catch (error) {
    failures.push(name);
    console.error(`  FAIL ${name}\n       ${error instanceof Error ? error.message : error}`);
  }
}

const attachment = {
  id: "prov-att",
  filename: "invoice.txt",
  mimeType: "text/plain",
  size: MARKER.length,
};

// AssistBar is compiled with the classic JSX runtime and does not import React.
(globalThis as { React?: typeof React }).React = React;

const legacyReader: ReaderMessage = {
  htmlBody: "",
  textBody: "Invoice attached",
  subject: "Invoice 4471",
  fromName: "Accounts",
  fromEmail: "accounts@example.com",
  toEmail: "owner@example.com",
  ccEmail: "",
  threadId: "thread-1",
  messageIdHeader: "<m@example.com>",
  attachments: [attachment],
  thread: [
    {
      id: "msg1",
      htmlBody: "",
      textBody: "Invoice attached",
      fromName: "Accounts",
      fromEmail: "accounts@example.com",
      attachments: [attachment],
    },
  ],
};

check("legacy thread links the attachment as a top-level GET", () => {
  const html = renderToString(createElement(LegacyThread, { reader: legacyReader }));
  assert.match(html, /<a [^>]*href="\/api\/messages\/msg1\/attachment\?/);
  assert.match(html, /aid=prov-att/);
  assert.match(html, /name=invoice\.txt/);
  assert.match(html, /type=text%2Fplain|type=text\/plain/);
  assert.doesNotMatch(html, /download=/);
});

check("assist bar links the same legacy attachment URL", () => {
  const html = renderToString(
    createElement(AssistBar, {
      reader: legacyReader,
      messageId: "msg1",
    }),
  );
  assert.match(html, /<a [^>]*href="\/api\/messages\/msg1\/attachment\?/);
  assert.match(html, /aid=prov-att/);
  assert.match(html, /target="_blank"/);
});

const v3Conversation: Conversation = {
  providerConversationId: "conv-1",
  subject: "Invoice 4471",
  lastMessageAt: "2026-08-11T15:20:00.000Z",
  messages: [
    {
      providerMessageId: "msg1",
      from: { name: "Accounts", email: "accounts@example.com" },
      to: [{ name: "Owner", email: "owner@example.com" }],
      cc: [],
      sentAt: "2026-08-11T15:20:00.000Z",
      snippet: "Invoice attached",
      bodyHtml: "<p>Invoice attached</p>",
      bodyText: "Invoice attached",
      isUnread: true,
      isOutgoing: false,
      attachments: [
        {
          id: "msg1-0",
          filename: "invoice.txt",
          mimeType: "text/plain",
          sizeBytes: MARKER.length,
        },
      ],
    },
  ],
};

check("v3 reader links the attachment as a top-level GET", () => {
  const href = attachmentUrl("msg1", "msg1-0");
  assert.equal(href, "/api/v3/messages/msg1/attachments/msg1-0");
  const html = renderToString(
    createElement(Reader, {
      provider: "google",
      conversation: v3Conversation,
      ownEmail: "owner@example.com",
      onReply: () => {},
      onReplyAll: () => {},
      onForward: () => {},
      onArchive: () => {},
      onDelete: () => {},
    }),
  );
  assert.match(html, /<a [^>]*href="\/api\/v3\/messages\/msg1\/attachments\/msg1-0"/);
});

function legacyRequest(url: string, id: string): Promise<Response> {
  return (legacyRoute.GET as RouteGet)(new Request(`http://127.0.0.1${url}`), {
    params: Promise.resolve({ id }),
  });
}

function v3Request(url: string, id: string, attachmentId: string): Promise<Response> {
  return (v3Route.GET as RouteGet)(new Request(`http://127.0.0.1${url}`), {
    params: Promise.resolve({ id, attachmentId }),
  });
}

async function callSigned(
  signedIn: boolean,
  run: () => Promise<Response>,
): Promise<{ status: number; cacheControl: string | null; body: string }> {
  return attachmentCacheAls().run({ signedIn }, async () => {
    const response = await run();
    const body = await response.text();
    return {
      status: response.status,
      cacheControl: response.headers.get("cache-control"),
      body,
    };
  });
}

async function checkAsync(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
    console.log(`  ok   ${name}`);
  } catch (error) {
    failures.push(name);
    console.error(`  FAIL ${name}\n       ${error instanceof Error ? error.message : error}`);
  }
}

await checkAsync("legacy download returns the authorized file", async () => {
  const result = await callSigned(true, () =>
    legacyRequest(
      "/api/messages/msg1/attachment?aid=prov-att&name=invoice.txt&type=text/plain",
      "msg1",
    ),
  );
  assert.equal(result.status, 200);
  assert.equal(result.body, MARKER);
});

await checkAsync("legacy download refuses a signed-out caller", async () => {
  const result = await callSigned(false, () =>
    legacyRequest(
      "/api/messages/msg1/attachment?aid=prov-att&name=invoice.txt&type=text/plain",
      "msg1",
    ),
  );
  assert.equal(result.status, 401);
  assert.equal(result.body.includes(MARKER), false);
});

await checkAsync("legacy download does not return a different message's file", async () => {
  const result = await callSigned(true, () =>
    legacyRequest(
      "/api/messages/other-msg/attachment?aid=prov-att&name=invoice.txt&type=text/plain",
      "other-msg",
    ),
  );
  assert.notEqual(result.status, 200);
  assert.equal(result.body.includes(MARKER), false);
});

await checkAsync("v3 download refuses a signed-out caller", async () => {
  const result = await callSigned(false, () =>
    v3Request("/api/v3/messages/msg1/attachments/msg1-0", "msg1", "msg1-0"),
  );
  assert.equal(result.status, 404);
  assert.equal(result.body.includes(MARKER), false);
});

await checkAsync("v3 download does not return a message the account does not own", async () => {
  const result = await callSigned(true, () =>
    v3Request("/api/v3/messages/other-msg/attachments/other-msg-0", "other-msg", "other-msg-0"),
  );
  assert.equal(result.status, 404);
  assert.equal(result.body.includes(MARKER), false);
});

type FileEvent = {
  url: string;
  status: number;
  fromDiskCache: boolean;
};

type ChromeSession = {
  chrome: ChildProcess;
  call: (method: string, params?: Record<string, unknown>, sessionId?: string) => Promise<any>;
  sessionId: string;
  events: FileEvent[];
  close: () => void;
};

async function openChrome(): Promise<ChromeSession> {
  const dir = mkdtempSync(join(tmpdir(), "attachment-cache-"));
  const chrome = spawn(
    "google-chrome",
    [
      "--headless=new",
      "--disable-gpu",
      "--no-sandbox",
      "--disable-dev-shm-usage",
      `--user-data-dir=${dir}`,
      "--remote-debugging-port=0",
      "about:blank",
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  const browserWs = await new Promise<string>((resolve, reject) => {
    let buf = "";
    const timer = setTimeout(() => reject(new Error(`chrome did not start: ${buf}`)), 15000);
    chrome.stderr?.on("data", (chunk: Buffer) => {
      buf += chunk.toString();
      const match = buf.match(/DevTools listening on (ws:\/\/\S+)/);
      if (match?.[1]) {
        clearTimeout(timer);
        resolve(match[1]);
      }
    });
    chrome.on("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`chrome exited ${code}: ${buf}`));
    });
  });
  const ws = new WebSocket(browserWs);
  await new Promise<void>((resolve, reject) => {
    ws.addEventListener("open", () => resolve());
    ws.addEventListener("error", () => reject(new Error("devtools websocket failed")));
  });
  let seq = 0;
  function call(method: string, params: Record<string, unknown> = {}, sessionId?: string) {
    const id = ++seq;
    return new Promise<any>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timeout ${method}`)), 8000);
      function onMessage(event: MessageEvent) {
        const message = JSON.parse(String(event.data)) as {
          id?: number;
          error?: unknown;
          result?: unknown;
        };
        if (message.id !== id) return;
        ws.removeEventListener("message", onMessage);
        clearTimeout(timer);
        if (message.error) reject(new Error(JSON.stringify(message.error)));
        else resolve(message.result);
      }
      ws.addEventListener("message", onMessage);
      ws.send(JSON.stringify({ id, sessionId, method, params }));
    });
  }
  const created = await call("Target.createTarget", { url: "about:blank" });
  const attached = await call("Target.attachToTarget", {
    targetId: created.targetId,
    flatten: true,
  });
  const sessionId = attached.sessionId as string;
  const events: FileEvent[] = [];
  ws.addEventListener("message", (event) => {
    const message = JSON.parse(String(event.data)) as {
      method?: string;
      params?: {
        response?: {
          url?: string;
          status?: number;
          fromDiskCache?: boolean;
        };
      };
    };
    const response = message.params?.response;
    if (message.method !== "Network.responseReceived" || !response?.url) return;
    if (!response.url.includes("/api/")) return;
    events.push({
      url: response.url,
      status: response.status ?? 0,
      fromDiskCache: response.fromDiskCache === true,
    });
  });
  await call("Network.enable", {}, sessionId);
  await call("Page.enable", {}, sessionId);
  await call(
    "Page.setDownloadBehavior",
    { behavior: "allow", downloadPath: dir },
    sessionId,
  );
  return {
    chrome,
    call,
    sessionId,
    events,
    close() {
      ws.close();
      chrome.kill();
    },
  };
}

async function pageText(chrome: ChromeSession): Promise<string> {
  const result = await chrome.call(
    "Runtime.evaluate",
    { expression: "document.body ? document.body.innerText : ''", returnByValue: true },
    chrome.sessionId,
  );
  return String(result.result?.value ?? "");
}

async function go(chrome: ChromeSession, url: string): Promise<string> {
  await chrome.call("Page.navigate", { url }, chrome.sessionId);
  await new Promise((resolve) => setTimeout(resolve, 500));
  return pageText(chrome);
}

function listen(
  handler: (req: IncomingMessage, res: ServerResponse) => Promise<void>,
): Promise<{ port: number; close: () => Promise<void> }> {
  const server = http.createServer((req, res) => {
    void handler(req, res).catch((error) => {
      if (!res.headersSent) {
        res.writeHead(500, { "Content-Type": "text/plain", "Cache-Control": "no-store" });
      }
      res.end(error instanceof Error ? error.message : "failed");
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("no port");
      resolve({
        port: address.port,
        close: () =>
          new Promise((done) => {
            server.closeAllConnections();
            server.close(() => done());
            setTimeout(done, 500);
          }),
      });
    });
  });
}

/**
 * Write the route's Response the way Next.js 15.5.23 does for a dynamic app
 * route: send-response.js copies status and headers, then pipes the body.
 * It does not replace a Cache-Control the handler already set.
 */
async function emitRouteResponse(
  req: IncomingMessage,
  res: ServerResponse,
  response: Response,
): Promise<void> {
  await sendResponse(new NodeNextRequest(req), new NodeNextResponse(res), response);
}

async function replayAfterSignOut(options: {
  name: string;
  chrome: ChromeSession;
  path: string;
  expectVisibleText: boolean;
  serve: (req: IncomingMessage) => Promise<Response>;
}): Promise<void> {
  const state = attachmentCacheState();
  state.bytes = Buffer.from(MARKER);
  state.calls = [];
  const marker = MARKER;
  const { port, close } = await listen(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (url.pathname === "/login") {
      res.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
        "Set-Cookie": "session=present; Path=/; HttpOnly",
      });
      res.end(`<a href="${options.path}">file</a>`);
      return;
    }
    if (url.pathname === "/other") {
      res.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
      });
      res.end("<p>signed-out-shell</p>");
      return;
    }
    if (url.pathname === "/favicon.ico") {
      res.writeHead(404, { "Cache-Control": "no-store" });
      res.end();
      return;
    }
    const signedIn = (req.headers.cookie ?? "").includes("session=present");
    await attachmentCacheAls().run({ signedIn }, async () => {
      const response = await options.serve(req);
      await emitRouteResponse(req, res, response);
    });
  });
  const origin = `http://127.0.0.1:${port}`;
  const before = options.chrome.events.length;
  try {
    await options.chrome.call("Network.clearBrowserCache", {}, options.chrome.sessionId);
    await options.chrome.call("Network.clearBrowserCookies", {}, options.chrome.sessionId);
    await go(options.chrome, `${origin}/login`);
    const opened = await go(options.chrome, `${origin}${options.path}`);
    if (options.expectVisibleText && !opened.includes(marker)) {
      throw new Error(
        `setup: signed-in navigation did not show the file (${JSON.stringify(opened).slice(0, 180)})`,
      );
    }
    const openedEvents = options.chrome.events.slice(before);
    const firstFile = openedEvents.find((event) => event.url.includes(options.path));
    if (!firstFile || firstFile.status !== 200 || firstFile.fromDiskCache) {
      throw new Error(`setup: first download was not a live 200 (${JSON.stringify(openedEvents)})`);
    }
    await go(options.chrome, `${origin}/other`);
    const signedOutAt = options.chrome.events.length;
    await options.chrome.call("Network.clearBrowserCookies", {}, options.chrome.sessionId);
    const history = await options.chrome.call("Page.getNavigationHistory", {}, options.chrome.sessionId);
    const previous = history.entries[history.currentIndex - 1];
    if (!previous) throw new Error("setup: no history entry to go back to");
    await options.chrome.call(
      "Page.navigateToHistoryEntry",
      { entryId: previous.id },
      options.chrome.sessionId,
    );
    await new Promise((resolve) => setTimeout(resolve, 500));
    const backText = await pageText(options.chrome);
    const reopened = await go(options.chrome, `${origin}${options.path}`);
    const after = options.chrome.events.slice(signedOutAt);
    const cached = after.filter((event) => event.fromDiskCache);
    const problems: string[] = [];
    if (cached.length > 0) {
      problems.push(`browser served ${cached.length} response(s) from disk cache after sign-out`);
    }
    if (options.expectVisibleText && (backText.includes(marker) || reopened.includes(marker))) {
      problems.push("file text was still on screen after the session cookie was cleared");
    }
    if (problems.length > 0) {
      throw new Error(problems.join("; "));
    }
  } finally {
    await close();
  }
}

function legacyServe(req: IncomingMessage): Promise<Response> {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  const id = decodeURIComponent(url.pathname.split("/")[3] ?? "");
  return legacyRequest(`${url.pathname}${url.search}`, id);
}

function v3Serve(req: IncomingMessage): Promise<Response> {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  const parts = url.pathname.split("/");
  const id = decodeURIComponent(parts[4] ?? "");
  const attachmentId = decodeURIComponent(parts[6] ?? "");
  return v3Request(`${url.pathname}${url.search}`, id, attachmentId);
}

const state = attachmentCacheState();
state.bytes = Buffer.from(MARKER);

const chrome = await openChrome();
try {
  const cases: Array<{
    name: string;
    path: string;
    visible: boolean;
    prepare: () => void;
    serve: (req: IncomingMessage) => Promise<Response>;
  }> = [
    {
      name: "legacy gmail text attachment",
      path: "/api/messages/msg1/attachment?aid=prov-att&name=invoice.txt&type=text/plain",
      visible: true,
      prepare: () => {
        state.legacyProvider = "google";
        state.mimeType = "text/plain";
        state.providerAttachmentId = "prov-att";
      },
      serve: legacyServe,
    },
    {
      name: "legacy graph text attachment",
      path: "/api/messages/msg1/attachment?aid=prov-att&name=invoice.txt&type=text/plain",
      visible: true,
      prepare: () => {
        state.legacyProvider = "microsoft-entra-id";
        state.mimeType = "text/plain";
        state.providerAttachmentId = "prov-att";
      },
      serve: legacyServe,
    },
    {
      name: "legacy gmail downloaded file",
      path: "/api/messages/msg1/attachment?aid=prov-att&name=invoice.bin&type=application/octet-stream",
      visible: false,
      prepare: () => {
        state.legacyProvider = "google";
        state.mimeType = "application/octet-stream";
        state.filename = "invoice.bin";
        state.providerAttachmentId = "prov-att";
      },
      serve: legacyServe,
    },
    {
      name: "v3 reader synthetic attachment id",
      path: "/api/v3/messages/msg1/attachments/msg1-0",
      visible: true,
      prepare: () => {
        state.mimeType = "text/plain";
        state.filename = "invoice.txt";
        state.providerAttachmentId = "prov-att";
      },
      serve: v3Serve,
    },
    {
      name: "v3 direct provider attachment id",
      path: "/api/v3/messages/msg1/attachments/prov-att",
      visible: true,
      prepare: () => {
        state.mimeType = "text/plain";
        state.filename = "invoice.txt";
        state.providerAttachmentId = "prov-att";
      },
      serve: v3Serve,
    },
  ];

  for (const item of cases) {
    item.prepare();
    try {
      await replayAfterSignOut({
        name: item.name,
        chrome,
        path: item.path,
        expectVisibleText: item.visible,
        serve: item.serve,
      });
      console.log(`  ok   ${item.name} is not readable after sign-out`);
    } catch (error) {
      failures.push(item.name);
      console.error(
        `  FAIL ${item.name}\n       ${error instanceof Error ? error.message : error}`,
      );
    }
  }
} finally {
  chrome.close();
}

if (failures.length > 0) {
  console.error(`attachment-cache: ${failures.length} failed`);
  process.exit(1);
}
console.log("attachment-cache: OK");
