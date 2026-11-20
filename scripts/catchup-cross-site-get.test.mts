/**
 * The catch-up brief is a GET that stores "last opened" on every successful
 * path. A signed-in browser will attach the session cookie to a cross-site
 * top-level navigation because the session cookie stays on Auth.js's default
 * SameSite=Lax policy. These tests are the spec for closing that:
 *
 * - No GET may move the last-open marker: not a cross-site navigation, not
 *   the app's own same-origin fetch, and not a request with no fetch metadata.
 *   That covers every markOpened call in the catch-up handler (first open,
 *   fewer than three new messages, and the summary that is actually returned).
 * - A same-origin POST, with the Origin and Sec-Fetch-Site headers Chrome
 *   sends on a same-origin fetch, records the open.
 * - A cross-site POST does not, even when the session cookie is attached.
 *
 * The marker assertions fail while the GET still writes. They pass once a
 * cross-site visit can no longer consume mail that arrived while the person
 * was away.
 */
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { encode } from "next-auth/jwt";
import { startTestDb } from "./v2-testdb.mts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, "..");
const AUTH_SECRET = "placeholder-auth-secret-for-catchup-tests";
const ACCOUNT_EMAIL = "catchup-csrf@rditrials.com";
const OPENED_AT = "2026-01-01T00:00:00.000Z";
const ARRIVED_AT = "2026-01-02T00:00:00.000Z";
const failures: string[] = [];

type CookieMod = {
  defaultCookies: (useSecureCookies: boolean) => {
    sessionToken: {
      name: string;
      options: {
        httpOnly: boolean;
        sameSite: string;
        path: string;
        secure: boolean;
      };
    };
  };
};

type SerializeMod = {
  serialize: (
    name: string,
    value: string,
    options: CookieMod["defaultCookies"] extends (s: boolean) => {
      sessionToken: { options: infer O };
    }
      ? O
      : never,
  ) => string;
};

const cookieJs = path.join(
  ROOT,
  "node_modules/@auth/core/lib/utils/cookie.js",
);
const serializeJs = path.join(
  ROOT,
  "node_modules/@auth/core/lib/vendored/cookie.js",
);

async function check(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    console.log(`PASS ${name}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`FAIL ${name}: ${message}`);
    failures.push(`${name}: ${message}`);
  }
}

function listen(
  host: string,
  handler: http.RequestListener,
  tls?: { cert: Buffer; key: Buffer },
) {
  const server = tls
    ? https.createServer(tls, handler)
    : http.createServer(handler);
  return new Promise<{ server: http.Server; port: number }>((resolve) => {
    server.listen(0, host, () => {
      const addr = server.address();
      if (!addr || typeof addr === "string") throw new Error("no port");
      resolve({ server, port: addr.port });
    });
  });
}

async function chromeSocket(): Promise<{
  chrome: ChildProcess;
  send: (method: string, params?: Record<string, unknown>) => Promise<unknown>;
  close: () => void;
}> {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "catchup-chrome-"));
  const debugPort = 9600 + Math.floor(Math.random() * 300);
  const chrome = spawn(
    "google-chrome",
    [
      "--headless=new",
      "--disable-gpu",
      "--no-sandbox",
      "--disable-dev-shm-usage",
      `--user-data-dir=${profile}`,
      `--remote-debugging-port=${debugPort}`,
      "--ignore-certificate-errors",
      "--no-first-run",
      "about:blank",
    ],
    { stdio: "ignore" },
  );
  let wsUrl = "";
  for (let i = 0; i < 50 && !wsUrl; i++) {
    try {
      const list = await fetch(`http://127.0.0.1:${debugPort}/json/list`);
      if (list.ok) {
        const pages = (await list.json()) as {
          webSocketDebuggerUrl: string;
          type: string;
        }[];
        wsUrl = pages.find((page) => page.type === "page")?.webSocketDebuggerUrl ?? "";
      }
    } catch {
      /* debugger not up yet */
    }
    if (!wsUrl) await new Promise((resolve) => setTimeout(resolve, 200));
  }
  if (!wsUrl) throw new Error("Chrome DevTools did not come up");
  const ws = new WebSocket(wsUrl);
  await new Promise<void>((resolve, reject) => {
    ws.onopen = () => resolve();
    ws.onerror = () => reject(new Error("Chrome DevTools socket failed"));
  });
  let id = 0;
  const pending = new Map<number, (value: unknown) => void>();
  ws.onmessage = (event) => {
    const message = JSON.parse(String(event.data)) as {
      id?: number;
      result?: unknown;
    };
    if (message.id && pending.has(message.id)) {
      pending.get(message.id)!(message.result);
      pending.delete(message.id);
    }
  };
  return {
    chrome,
    send: (method, params = {}) => {
      const msgId = ++id;
      ws.send(JSON.stringify({ id: msgId, method, params }));
      return new Promise((resolve) => pending.set(msgId, resolve));
    },
    close: () => {
      ws.close();
      chrome.kill("SIGKILL");
      fs.rmSync(profile, { recursive: true, force: true });
    },
  };
}

async function browserSendsSessionCookie() {
  const { defaultCookies } = (await import(cookieJs)) as CookieMod;
  const { serialize } = (await import(serializeJs)) as SerializeMod;
  const authSource = fs.readFileSync(path.join(ROOT, "src/auth.ts"), "utf8");
  assert.equal(
    authSource.includes("useSecureCookies"),
    false,
    "src/auth.ts must not override useSecureCookies",
  );
  assert.equal(
    /cookies\s*:/.test(authSource),
    false,
    "src/auth.ts must not override Auth.js cookie options",
  );
  for (const secure of [false, true]) {
    const session = defaultCookies(secure).sessionToken;
    assert.equal(session.options.sameSite, "lax");
    assert.equal(session.options.secure, secure);
    assert.equal(session.options.httpOnly, true);
  }

  const secureCookie = defaultCookies(true).sessionToken;
  const setCookie = serialize(secureCookie.name, "probe-value", secureCookie.options);
  const certDir = fs.mkdtempSync(path.join(os.tmpdir(), "catchup-cert-"));
  const certPath = path.join(certDir, "cert.pem");
  const keyPath = path.join(certDir, "key.pem");
  const openssl = spawn(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-keyout",
      keyPath,
      "-out",
      certPath,
      "-days",
      "1",
      "-nodes",
      "-subj",
      "/CN=localhost",
      "-addext",
      "subjectAltName=DNS:localhost,IP:127.0.0.1",
    ],
    { stdio: "ignore" },
  );
  const opensslExit = await once(openssl, "exit");
  assert.equal(opensslExit[0], 0, "openssl could not mint a local certificate");
  const tls = {
    cert: fs.readFileSync(certPath),
    key: fs.readFileSync(keyPath),
  };
  const seen = new Map<string, { cookie: string | null; site: string | null; mode: string | null; origin: string | null }>();
  const app = await listen(
    "127.0.0.1",
    (req, res) => {
      if ((req.url ?? "").startsWith("/set")) {
        res.writeHead(200, {
          "Set-Cookie": setCookie,
          "Content-Type": "text/html",
        });
        res.end("<p>set</p>");
        return;
      }
      seen.set(req.url ?? "", {
        cookie: req.headers.cookie ?? null,
        site: header(req.headers["sec-fetch-site"]),
        mode: header(req.headers["sec-fetch-mode"]),
        origin: header(req.headers.origin),
      });
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end("<p>landed</p>");
    },
    tls,
  );
  const evil = await listen(
    "localhost",
    (req, res) => {
      const target = `https://127.0.0.1:${app.port}/navigate`;
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(
        `<!doctype html><a id="x" href="${target}">go</a><script>location.assign(document.getElementById("x").href)</script>`,
      );
    },
    tls,
  );
  const browser = await chromeSocket();
  try {
    await browser.send("Page.enable");
    await browser.send("Page.navigate", {
      url: `https://127.0.0.1:${app.port}/set`,
    });
    await new Promise((resolve) => setTimeout(resolve, 800));
    await browser.send("Page.navigate", {
      url: `https://localhost:${evil.port}/go`,
    });
    const deadline = Date.now() + 5000;
    while (!seen.has("/navigate") && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  } finally {
    browser.close();
    app.server.close();
    evil.server.close();
    fs.rmSync(certDir, { recursive: true, force: true });
  }
  const landed = seen.get("/navigate");
  assert.ok(landed, "cross-site navigation never reached the app host");
  assert.equal(landed.site, "cross-site");
  assert.equal(landed.mode, "navigate");
  assert.equal(landed.origin, null);
  assert.equal(
    landed.cookie,
    `${secureCookie.name}=probe-value`,
    "production-shaped session cookie was not sent on the cross-site GET",
  );
}

function header(value: string | string[] | undefined): string | null {
  if (Array.isArray(value)) return value[0] ?? null;
  return value ?? null;
}

type MailRow = {
  id: string;
  threadId: string;
  fromEmail: string;
  fromName: string;
  subject: string;
  snippet: string;
  receivedAt: string;
  isUnread: boolean;
};

function mail(count: number): MailRow[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `msg-${count}-${index}`,
    threadId: `thread-${count}-${index}`,
    fromEmail: `person${index}@example.com`,
    fromName: `Person ${index}`,
    subject: `Question ${index} while you were away`,
    snippet: "Can you look at this today?",
    receivedAt: ARRIVED_AT,
    isUnread: true,
  }));
}

async function main() {
  await check(
    "browser sends the Secure SameSite=Lax session cookie on a cross-site GET",
    browserSendsSessionCookie,
  );

  const database = await startTestDb();
  const portRow = await database.pool.query<{ port: string }>(
    "select inet_server_port()::text as port",
  );
  const databaseUrl = `postgres://postgres:postgres@127.0.0.1:${portRow.rows[0].port}/seer_test`;
  process.env.NODE_ENV = "development";
  process.env.SEER_V2_DATABASE_URL = databaseUrl;
  process.env.POSTGRES_URL = databaseUrl;
  delete process.env.SEER_CREDENTIAL_KEY;
  delete process.env.UPSTASH_REDIS_REST_URL;
  delete process.env.UPSTASH_REDIS_REST_TOKEN;
  delete process.env.KV_REST_API_URL;
  delete process.env.KV_REST_API_TOKEN;

  const [
    { upsertUser, upsertAccountWithCredentials },
    { kvDelete, accountKey },
    { readLastOpen },
    { getInboxSnapshot },
    { saveCachedHistory },
  ] = await Promise.all([
    import("../src/lib/v2/db/accounts.ts"),
    import("../src/lib/store/kv.ts"),
    import("../src/lib/store/last-open.ts"),
    import("../src/lib/mail/inbox-snapshot.ts"),
    import("../src/lib/inbox/mail-history-store.ts"),
  ]);

  const userId = await upsertUser(ACCOUNT_EMAIL);
  await upsertAccountWithCredentials({
    userId,
    provider: "microsoft",
    email: ACCOUNT_EMAIL,
    displayName: "Catchup Person",
    accessToken: "placeholder-access-token",
    expiresAt: Date.now() + 60 * 60 * 1000,
  });
  const markerKey = `last-open:${accountKey(ACCOUNT_EMAIL)}`;
  await saveCachedHistory({
    accountEmail: ACCOUNT_EMAIL,
    builtAt: new Date().toISOString(),
    contacts: {},
    engagedCount: 0,
    contactCount: 0,
    repliedThreads: {},
  });

  const appPort = 3400 + Math.floor(Math.random() * 1000);
  const origin = `http://127.0.0.1:${appPort}`;
  const childEnv: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    TMPDIR: process.env.TMPDIR,
    LANG: process.env.LANG,
    NODE_ENV: "development",
    AUTH_SECRET,
    AUTH_URL: origin,
    SEER_V2_DATABASE_URL: databaseUrl,
    POSTGRES_URL: databaseUrl,
  };
  const logs: string[] = [];
  const server = spawn(
    "node",
    [
      path.join(ROOT, "node_modules/next/dist/bin/next"),
      "dev",
      "--turbopack",
      "--hostname",
      "127.0.0.1",
      "--port",
      String(appPort),
    ],
    { cwd: ROOT, env: childEnv, stdio: ["ignore", "pipe", "pipe"] },
  );
  server.stdout?.on("data", (chunk) => logs.push(String(chunk)));
  server.stderr?.on("data", (chunk) => logs.push(String(chunk)));

  try {
    await waitForRoute(origin, logs);
    const session = await encode({
      token: {
        sub: ACCOUNT_EMAIL,
        email: ACCOUNT_EMAIL,
        name: "Catchup Person",
        provider: "microsoft-entra-id",
      },
      secret: AUTH_SECRET,
      salt: "authjs.session-token",
    });
    const cookie = `authjs.session-token=${session}`;

    async function plant(openedAt: string | null, count: number) {
      if (openedAt) {
        const { kvSet } = await import("../src/lib/store/kv.ts");
        await kvSet(markerKey, openedAt);
      } else {
        await kvDelete(markerKey);
      }
      await getInboxSnapshot(ACCOUNT_EMAIL, async () => mail(count), {
        force: true,
      });
      assert.equal(await readLastOpen(ACCOUNT_EMAIL), openedAt);
    }

    async function call(
      method: "GET" | "POST",
      headers: Record<string, string>,
    ) {
      const response = await fetch(`${origin}/api/catchup`, {
        method,
        headers: { cookie, ...headers },
        body: method === "POST" ? "{}" : undefined,
        redirect: "manual",
      });
      const text = await response.text();
      let body: Record<string, unknown> = {};
      try {
        body = JSON.parse(text) as Record<string, unknown>;
      } catch {
        body = { raw: text.slice(0, 300) };
      }
      return { status: response.status, body };
    }

    const navigation: Record<string, string> = {
      "sec-fetch-site": "cross-site",
      "sec-fetch-mode": "navigate",
      "sec-fetch-dest": "document",
      referer: "https://localhost/",
    };
    const sameOriginGet: Record<string, string> = {
      "sec-fetch-site": "same-origin",
      "sec-fetch-mode": "cors",
      "sec-fetch-dest": "empty",
      referer: `${origin}/`,
    };
    const sameOriginPost: Record<string, string> = {
      ...sameOriginGet,
      origin,
      "content-type": "application/json",
    };
    const crossSitePost: Record<string, string> = {
      "sec-fetch-site": "cross-site",
      "sec-fetch-mode": "navigate",
      "sec-fetch-dest": "document",
      origin: "https://evil.example",
      referer: "https://evil.example/",
      "content-type": "application/json",
    };

    await check(
      "cross-site GET does not create the first-open marker",
      async () => {
        await plant(null, 2);
        const response = await call("GET", navigation);
        assert.equal(
          await readLastOpen(ACCOUNT_EMAIL),
          null,
          `marker was written (status ${response.status} ${JSON.stringify(response.body)})`,
        );
        const follow = await call("GET", sameOriginGet);
        assert.equal(follow.status, 200, JSON.stringify(follow.body));
        assert.equal(follow.body.quiet, true);
        assert.equal(
          follow.body.newCount,
          undefined,
          "the visit was treated as an earlier open, so away mail is already outside the window",
        );
        assert.equal(await readLastOpen(ACCOUNT_EMAIL), null);
      },
    );

    await check(
      "cross-site GET does not advance the marker when the inbox is quiet",
      async () => {
        await plant(OPENED_AT, 2);
        const response = await call("GET", navigation);
        assert.equal(response.status, 200, JSON.stringify(response.body));
        assert.equal(response.body.quiet, true);
        assert.equal(response.body.newCount, 2);
        assert.equal(
          await readLastOpen(ACCOUNT_EMAIL),
          OPENED_AT,
          "quiet catch-up wrote the last-open marker",
        );
        const follow = await call("GET", sameOriginGet);
        assert.equal(follow.status, 200, JSON.stringify(follow.body));
        assert.equal(follow.body.newCount, 2);
        assert.equal(await readLastOpen(ACCOUNT_EMAIL), OPENED_AT);
      },
    );

    await check(
      "cross-site GET with an attacker Origin does not advance the marker",
      async () => {
        await plant(OPENED_AT, 2);
        await call("GET", { ...navigation, origin: "https://evil.example" });
        assert.equal(await readLastOpen(ACCOUNT_EMAIL), OPENED_AT);
      },
    );

    await check(
      "cross-site GET does not advance the marker when it returns the summary",
      async () => {
        await plant(OPENED_AT, 3);
        const response = await call("GET", navigation);
        assert.equal(response.status, 200, JSON.stringify(response.body));
        assert.equal(response.body.quiet, false);
        assert.equal(response.body.newCount, 3);
        assert.equal(response.body.since, OPENED_AT);
        assert.equal(
          await readLastOpen(ACCOUNT_EMAIL),
          OPENED_AT,
          "the summary path wrote the last-open marker",
        );
        const follow = await call("GET", sameOriginGet);
        assert.equal(follow.status, 200, JSON.stringify(follow.body));
        assert.equal(follow.body.quiet, false);
        assert.equal(follow.body.newCount, 3);
        assert.equal(follow.body.since, OPENED_AT);
        assert.equal(await readLastOpen(ACCOUNT_EMAIL), OPENED_AT);
      },
    );

    await check("a GET with no fetch metadata does not move the marker", async () => {
      await plant(OPENED_AT, 2);
      await call("GET", {});
      assert.equal(await readLastOpen(ACCOUNT_EMAIL), OPENED_AT);
    });

    await check("the app's same-origin GET does not move the marker", async () => {
      await plant(OPENED_AT, 2);
      const response = await call("GET", sameOriginGet);
      assert.equal(response.status, 200, JSON.stringify(response.body));
      assert.equal(response.body.newCount, 2);
      assert.equal(await readLastOpen(ACCOUNT_EMAIL), OPENED_AT);
    });

    await check("a same-origin POST records the open", async () => {
      await plant(OPENED_AT, 2);
      const before = Date.now();
      const response = await call("POST", sameOriginPost);
      assert.equal(response.status, 200, JSON.stringify(response.body));
      const marker = await readLastOpen(ACCOUNT_EMAIL);
      assert.ok(marker, "same-origin POST did not record the open");
      assert.ok(Date.parse(marker) >= before - 5_000, marker);
      const follow = await call("GET", sameOriginGet);
      assert.equal(follow.body.newCount, 0);
    });

    await check(
      "a cross-site POST does not record the open",
      async () => {
        await plant(OPENED_AT, 2);
        await call("POST", crossSitePost);
        assert.equal(await readLastOpen(ACCOUNT_EMAIL), OPENED_AT);
      },
    );

    await check("a cross-site GET without a session does not record an open", async () => {
      await plant(OPENED_AT, 2);
      const response = await fetch(`${origin}/api/catchup`, {
        headers: navigation,
        redirect: "manual",
      });
      assert.equal(response.status, 401);
      assert.equal(await readLastOpen(ACCOUNT_EMAIL), OPENED_AT);
    });
  } finally {
    server.kill("SIGKILL");
    await database.stop().catch(() => {});
  }

  if (failures.length > 0) {
    console.error(`\n${failures.length} test(s) failed`);
    process.exit(1);
  }
}

async function waitForRoute(origin: string, logs: string[]) {
  const deadline = Date.now() + 180_000;
  let last = "";
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${origin}/api/catchup`);
      const text = await response.text();
      last = `${response.status} ${text.slice(0, 240)}`;
      if (response.status === 401 || response.status === 200) return;
    } catch (error) {
      last = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
  throw new Error(
    `catch-up route did not start: ${last}\n${logs.join("").slice(-2000)}`,
  );
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : error);
  process.exit(1);
});
