/**
 * Cross-site GET grading of the signed-in mailbox.
 *
 * These assertions describe the safe behavior. They fail while
 * GET /api/today, GET /api/mailbox, and GET /api/alltasks still grade
 * the inbox and write those grades back.
 *
 * Run: npx tsx scripts/csrf-inbox-get.test.mts
 */
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { encode } from "next-auth/jwt";
import { startTestDb } from "./v2-testdb.mts";
import { upsertAccountWithCredentials, upsertUser } from "../src/lib/v2/db/accounts.ts";

const require = createRequire(import.meta.url);
const { defaultCookies } = require(
  "../node_modules/@auth/core/lib/utils/cookie.js",
) as {
  defaultCookies: (useSecureCookies: boolean) => {
    sessionToken: {
      name: string;
      options: { httpOnly: boolean; sameSite: string; path: string; secure: boolean };
    };
  };
};

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const AUTH_SECRET = "test-auth-secret-placeholder";
const ACCOUNT_EMAIL = "desk@rditrials.com";
const MESSAGE_ID = "msg-gray-1";
const BODY_MARKER = "CROSS-SITE-BODY-MARKER";
const TRACE = path.join(os.tmpdir(), `seer-csrf-trace-${process.pid}.json`);

const httpCookie = defaultCookies(false).sessionToken;
const httpsCookie = defaultCookies(true).sessionToken;

assert.equal(httpCookie.options.sameSite, "lax");
assert.equal(httpCookie.options.httpOnly, true);
assert.equal(httpCookie.options.secure, false);
assert.equal(httpCookie.name, "authjs.session-token");
assert.equal(httpsCookie.options.sameSite, "lax");
assert.equal(httpsCookie.options.secure, true);
assert.equal(httpsCookie.name, "__Secure-authjs.session-token");

const authSource = fs.readFileSync(path.join(ROOT, "src/auth.ts"), "utf8");
assert.equal(
  /cookies\s*:/.test(authSource),
  false,
  "NextAuth() must be checked for a cookies override; this app does not set one",
);

type CookieProbe = { sent: boolean; sameSite: "Lax" | "Strict" };

async function listen(
  host: string,
  handler: http.RequestListener,
): Promise<{ server: http.Server; port: number }> {
  const server = http.createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, host, resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no port");
  return { server, port: address.port };
}

async function browserSendsCookieOnCrossSiteGet(
  sameSite: "Lax" | "Strict",
): Promise<boolean> {
  let seen = "";
  // lvh.me resolves to 127.0.0.1 and is a different site from localhost.
  const appHost = "lvh.me";
  const attackerHost = "localhost";
  const app = await listen("127.0.0.1", (req, res) => {
    // Only the top-level document navigation counts. A later same-site
    // favicon request is not the attack and will carry a Strict cookie.
    if (req.url?.startsWith("/land")) seen = req.headers.cookie ?? "";
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("ok");
  });
  const attacker2 = await listen(attackerHost, (_req, res) => {
    res.writeHead(200, { "content-type": "text/html" });
    res.end(
      `<!doctype html><script>location = ${JSON.stringify(
        `http://${appHost}:${app.port}/land`,
      )}</script>`,
    );
  });

  const chrome = spawn(
    "google-chrome",
    [
      "--headless=new",
      "--no-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu",
      `--remote-debugging-port=0`,
      "--user-data-dir=" + fs.mkdtempSync(path.join(os.tmpdir(), "seer-chrome-")),
      "about:blank",
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  let debugPort = 0;
  const stderr: Buffer[] = [];
  chrome.stderr?.on("data", (chunk: Buffer) => {
    stderr.push(chunk);
    const text = Buffer.concat(stderr).toString("utf8");
    const match = text.match(/DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)\//);
    if (match) debugPort = Number(match[1]);
  });
  const started = Date.now();
  while (!debugPort && Date.now() - started < 15000) {
    if (chrome.exitCode != null) break;
    await new Promise((r) => setTimeout(r, 50));
  }
  if (!debugPort) {
    chrome.kill("SIGKILL");
    app.server.close();
    attacker2.server.close();
    throw new Error(
      `chrome did not expose DevTools: ${Buffer.concat(stderr).toString("utf8").slice(-500)}`,
    );
  }

  const version = (await (
    await fetch(`http://127.0.0.1:${debugPort}/json/version`)
  ).json()) as { webSocketDebuggerUrl: string };
  const ws = new WebSocket(version.webSocketDebuggerUrl);
  await new Promise<void>((resolve, reject) => {
    ws.addEventListener("open", () => resolve());
    ws.addEventListener("error", () => reject(new Error("devtools websocket failed")));
  });
  let id = 0;
  const pending = new Map<number, (value: unknown) => void>();
  ws.addEventListener("message", (event) => {
    const data = JSON.parse(String(event.data)) as {
      id?: number;
      result?: unknown;
    };
    if (data.id && pending.has(data.id)) {
      pending.get(data.id)!(data.result);
      pending.delete(data.id);
    }
  });
  const send = (method: string, params: Record<string, unknown> = {}) =>
    new Promise<unknown>((resolve) => {
      const msgId = ++id;
      pending.set(msgId, resolve);
      ws.send(JSON.stringify({ id: msgId, method, params }));
    });

  try {
    const created = (await send("Target.createTarget", { url: "about:blank" })) as {
      targetId: string;
    };
    const attached = (await send("Target.attachToTarget", {
      targetId: created.targetId,
      flatten: true,
    })) as { sessionId: string };
    const sessionId = attached.sessionId;
    const sessionSend = (method: string, params: Record<string, unknown> = {}) =>
      send("Target.sendMessageToTarget", {
        sessionId,
        message: JSON.stringify({ id: ++id, method, params }),
      });
    // Flattened sessions return events, not the inner result, via the
    // browser socket. Drive the page target's own websocket instead.
    const targets = (await (
      await fetch(`http://127.0.0.1:${debugPort}/json/list`)
    ).json()) as { id: string; webSocketDebuggerUrl: string; type: string }[];
    const page = targets.find((t) => t.id === created.targetId);
    if (!page) throw new Error("chrome page target missing");
    const pageWs = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise<void>((resolve, reject) => {
      pageWs.addEventListener("open", () => resolve());
      pageWs.addEventListener("error", () => reject(new Error("page websocket failed")));
    });
    let pageId = 0;
    const pagePending = new Map<number, (value: unknown) => void>();
    pageWs.addEventListener("message", (event) => {
      const data = JSON.parse(String(event.data)) as {
        id?: number;
        result?: unknown;
      };
      if (data.id && pagePending.has(data.id)) {
        pagePending.get(data.id)!(data.result);
        pagePending.delete(data.id);
      }
    });
    const pageSend = (method: string, params: Record<string, unknown> = {}) =>
      new Promise<unknown>((resolve) => {
        const msgId = ++pageId;
        pagePending.set(msgId, resolve);
        pageWs.send(JSON.stringify({ id: msgId, method, params }));
      });
    await pageSend("Network.enable");
    await pageSend("Page.enable");
    await pageSend("Network.setCookie", {
      name: httpCookie.name,
      value: "probe-session",
      url: `http://${appHost}:${app.port}/`,
      path: httpCookie.options.path,
      httpOnly: httpCookie.options.httpOnly,
      secure: httpCookie.options.secure,
      sameSite,
    });
    await pageSend("Page.navigate", {
      url: `http://${attackerHost}:${attacker2.port}/go`,
    });
    const deadline = Date.now() + 8000;
    while (!seen && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 50));
    }
    pageWs.close();
    void sessionSend;
    return seen.includes(`${httpCookie.name}=probe-session`);
  } finally {
    ws.close();
    chrome.kill("SIGKILL");
    app.server.close();
    attacker2.server.close();
  }
}

const laxProbe = await browserSendsCookieOnCrossSiteGet("Lax");
const strictProbe = await browserSendsCookieOnCrossSiteGet("Strict");
const probes: CookieProbe[] = [
  { sent: laxProbe, sameSite: "Lax" },
  { sent: strictProbe, sameSite: "Strict" },
];
assert.equal(
  probes.find((p) => p.sameSite === "Lax")?.sent,
  true,
  "a SameSite=Lax host cookie must be sent on a top-level cross-site GET",
);
assert.equal(
  probes.find((p) => p.sameSite === "Strict")?.sent,
  false,
  "SameSite=Strict is the setting that would withhold the cookie; Lax does not",
);

fs.writeFileSync(TRACE, "[]");
const db = await startTestDb();
const userId = await upsertUser(ACCOUNT_EMAIL);
const account = await upsertAccountWithCredentials({
  userId,
  provider: "google",
  email: ACCOUNT_EMAIL,
  displayName: "Desk",
  accessToken: "test-mailbox-access-token",
  expiresAt: Math.floor(Date.now() / 1000) + 3600,
});

const sessionToken = await encode({
  token: {
    email: ACCOUNT_EMAIL,
    sub: userId,
    name: "Desk",
    provider: "google",
    activeAccountId: account.id,
  },
  secret: AUTH_SECRET,
  salt: httpCookie.name,
});

const port = 18000 + (process.pid % 10000);
const poolPort = await db.pool.query<{ port: string }>("show port");
const childEnv = {
  ...process.env,
  NODE_ENV: "development",
  AUTH_SECRET,
  AUTH_URL: `http://127.0.0.1:${port}`,
  AUTH_GOOGLE_ID: "test-google-client-id",
  AUTH_GOOGLE_SECRET: "test-google-client-secret",
  GOOGLE_GENERATIVE_AI_API_KEY: "test-gemini-key",
  SEER_GEMINI_MODEL: "gemini-2.0-flash",
  SEER_CSRF_TRACE: TRACE,
  SEER_CSRF_MSG_ID: MESSAGE_ID,
  SEER_CSRF_BODY_MARKER: BODY_MARKER,
  POSTGRES_URL: `postgres://postgres:postgres@127.0.0.1:${poolPort.rows[0].port}/seer_test`,
  NODE_OPTIONS: `--require ${path.join(ROOT, "scripts/csrf-inbox-get-preload.cjs")}`,
};

const server = spawn(
  "npx",
  ["next", "dev", "--port", String(port), "--hostname", "127.0.0.1"],
  {
    cwd: ROOT,
    env: childEnv,
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  },
);
let serverLog = "";
server.stdout?.on("data", (chunk: Buffer) => {
  serverLog += chunk.toString("utf8");
});
server.stderr?.on("data", (chunk: Buffer) => {
  serverLog += chunk.toString("utf8");
});

async function stopAll() {
  try {
    if (server.pid) process.kill(-server.pid, "SIGTERM");
  } catch {
    server.kill("SIGTERM");
  }
  await db.stop();
}

function readTrace(): {
  kind: string;
  bodySent?: boolean;
  includesTarget?: boolean;
}[] {
  try {
    return JSON.parse(fs.readFileSync(TRACE, "utf8")) as {
      kind: string;
      bodySent?: boolean;
      includesTarget?: boolean;
    }[];
  } catch {
    return [];
  }
}

async function gradeKeys(): Promise<string[]> {
  const rows = await db.pool.query<{ key: string }>(
    `select key from seer_kv
      where key like 'decisions:%'
         or key like 'people:%'
         or key like 'merchants:%'`,
  );
  return rows.rows.map((row) => row.key);
}

async function clearGrades() {
  fs.writeFileSync(TRACE, "[]");
  await db.pool.query(
    `delete from seer_kv
      where key like 'decisions:%'
         or key like 'people:%'
         or key like 'merchants:%'
         or key like 'inbox-snap:%'
         or key like 'gmail-labels:%'
         or key like 'labels-era:%'
         or key like 'mailhist:%'
         or key like 'personal:%'
         or key like 'kept:%'`,
  );
}

const routes = ["/api/today", "/api/mailbox", "/api/alltasks"] as const;

try {
  const readyAt = Date.now();
  let ready = false;
  while (Date.now() - readyAt < 120000) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/today`);
      if (res.status === 401 || res.status === 200 || res.status === 502) {
        ready = true;
        break;
      }
    } catch {
      /* server still booting */
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  if (!ready) {
    throw new Error(`next dev did not listen:\n${serverLog.slice(-2000)}`);
  }

  const anonymous = await fetch(`http://127.0.0.1:${port}/api/today`, {
    headers: {
      "sec-fetch-site": "cross-site",
      "sec-fetch-mode": "navigate",
      "sec-fetch-dest": "document",
    },
  });
  assert.equal(anonymous.status, 401);

  const violations: string[] = [];
  for (const route of routes) {
    await clearGrades();
    const headers = {
      cookie: `${httpCookie.name}=${sessionToken}`,
      "sec-fetch-site": "cross-site",
      "sec-fetch-mode": "navigate",
      "sec-fetch-dest": "document",
    };
    const res = await fetch(`http://127.0.0.1:${port}${route}`, { headers });
    const text = await res.text();
    const deadline = Date.now() + 5000;
    let trace = readTrace();
    while (
      Date.now() < deadline &&
      !trace.some((event) => event.kind === "batchModify" || event.kind === "model")
    ) {
      await new Promise((r) => setTimeout(r, 100));
      trace = readTrace();
    }
    const grades = await gradeKeys();
    const wroteLabels = trace.some(
      (event) => event.kind === "batchModify" && event.includesTarget,
    );
    const sentBody = trace.some((event) => event.kind === "model" && event.bodySent);
    if (wroteLabels || sentBody || grades.length > 0) {
      violations.push(
        `${route} status ${res.status} relabeled=${wroteLabels} bodySent=${sentBody} grades=${grades.join(",") || "none"} trace=${JSON.stringify(trace)} body=${text.slice(0, 180)}`,
      );
    }
  }

  assert.deepEqual(
    violations,
    [],
    "a signed-in cross-site top-level GET must not grade or relabel:\n" +
      violations.join("\n"),
  );
} finally {
  await stopAll();
}

console.log("csrf-inbox-get: OK");
