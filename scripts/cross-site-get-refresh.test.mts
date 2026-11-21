/**
 * Cross-site top-level GET must not spend the signed-in mailbox's provider
 * quota or rewrite the caches those reads fill.
 *
 * The session cookie is Auth.js' default SameSite=Lax cookie. A browser
 * attaches that cookie to a cross-site top-level navigation whose method
 * is safe (GET). These tests send that request, with the real session
 * decoder and the real contact / history loaders, and require the handler
 * to finish without calling the mailbox provider or changing stored caches.
 *
 * They fail while a signed-in cross-site navigation still refreshes
 * provider data. A fix that checks the request only after those calls, or
 * that still refreshes when Origin is absent, keeps failing them.
 */
import "./cross-site-get-env.mts";

import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { encode } from "@auth/core/jwt";
import { workAsyncStorage } from "next/dist/server/app-render/work-async-storage.external.js";
import { workUnitAsyncStorage } from "next/dist/server/app-render/work-unit-async-storage.external.js";
import { HeadersAdapter } from "next/dist/server/web/spec-extension/adapters/headers.js";
import { RequestCookiesAdapter } from "next/dist/server/web/spec-extension/adapters/request-cookies.js";
import { RequestCookies } from "next/dist/server/web/spec-extension/cookies.js";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";
import { setPoolForTesting } from "../src/lib/v2/db/pool.ts";
import { upsertAccountWithCredentials, upsertUser } from "../src/lib/v2/db/accounts.ts";
import { kvDelete, kvGet, kvSet } from "../src/lib/store/kv.ts";

const DB_NAME = "seer_cross_site_get";
const DB_PASSWORD = "placeholder-db-password";

const APP_ORIGIN = "https://seer.example";
const ATTACKER_ORIGIN = "https://attacker.example";
const SESSION_COOKIE = "__Secure-authjs.session-token";
const PLACEHOLDER_TOKEN = "placeholder-mailbox-access-token";
const GOOGLE_EMAIL = "victim@rditrials.com";
const MICROSOFT_EMAIL = "victim.ms@rditrials.com";

type Provider = "google" | "microsoft";

type FetchCall = { url: string; usedSessionToken: boolean };

const fetchCalls: FetchCall[] = [];

function installFetchStandIn(): void {
  const original = globalThis.fetch;
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
    fetchCalls.push({
      url,
      usedSessionToken: headers.get("authorization") === `Bearer ${PLACEHOLDER_TOKEN}`,
    });
    // Shapes read by the Gmail, People, Calendar, and Graph parsers. The
    // stand-in never forwards the request.
    void original;
    return new Response(
      JSON.stringify({
        connections: [],
        otherContacts: [],
        items: [],
        messages: [],
        value: [],
        labels: [],
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  };
}

async function sessionCookie(input: {
  email: string;
  provider: "google" | "microsoft-entra-id";
}): Promise<string> {
  const token = await encode({
    salt: SESSION_COOKIE,
    secret: process.env.AUTH_SECRET!,
    token: {
      email: input.email,
      sub: input.email,
      name: "Victim",
      provider: input.provider,
    },
  });
  return `${SESSION_COOKIE}=${token}`;
}

function redactUrl(raw: string): string {
  try {
    const url = new URL(raw);
    if (url.searchParams.has("access_token")) {
      url.searchParams.set("access_token", "redacted");
    }
    return url.toString();
  } catch {
    return raw.split("?")[0] ?? raw;
  }
}

async function seedStaleCaches(email: string): Promise<void> {
  const contactsBuiltAt = new Date(Date.now() - 7 * 60 * 60 * 1000).toISOString();
  const eventsBuiltAt = new Date(Date.now() - 6 * 60 * 1000).toISOString();
  const historyBuiltAt = new Date(Date.now() - 16 * 60 * 1000).toISOString();
  await kvSet(`personal:${email}`, {
    builtAt: contactsBuiltAt,
    eventsBuiltAt,
    contacts: ["kept@example.com"],
    autoContacts: ["auto@example.com"],
    events: [
      {
        subject: "Stale standup",
        startsAt: "2020-01-01T00:00:00.000Z",
        attendees: ["kept@example.com"],
      },
    ],
    health: { people: "ok", calendar: "ok" },
  });
  await kvSet(`mail-history:${email}`, {
    builtAt: historyBuiltAt,
    history: {
      accountEmail: email,
      builtAt: historyBuiltAt,
      contacts: {},
      engagedCount: 0,
      contactCount: 0,
    },
  });
}

async function snapshotStore(): Promise<string> {
  const dir = process.env.SEER_DATA_DIR!;
  let names: string[] = [];
  try {
    names = (await fs.readdir(dir)).sort();
  } catch {
    names = [];
  }
  const files: Record<string, string> = {};
  for (const name of names) {
    files[name] = await fs.readFile(`${dir}/${name}`, "utf8");
  }
  return JSON.stringify(files);
}

type WorkStore = {
  isStaticGeneration: boolean;
  page: string;
  route: string;
  forceStatic: boolean;
  dynamicShouldError: boolean;
  afterContext: { after(task: () => unknown): void };
};

type RequestStore = {
  type: "request";
  phase: "render";
  implicitTags: { tags: string[] };
  url: { pathname: string; search: string };
  headers: ReturnType<typeof HeadersAdapter.seal>;
  cookies: ReturnType<typeof RequestCookiesAdapter.seal>;
  mutableCookies: ReturnType<typeof RequestCookiesAdapter.seal>;
  userspaceMutableCookies: ReturnType<typeof RequestCookiesAdapter.seal>;
  rootParams: Record<string, string>;
  renderResumeDataCache: null;
  draftMode: { isEnabled: boolean };
};

async function withRequest<T>(request: Request, run: () => Promise<T>): Promise<T> {
  const headerList = new Headers(request.headers);
  const sealedHeaders = HeadersAdapter.seal(headerList);
  const sealedCookies = RequestCookiesAdapter.seal(new RequestCookies(headerList));
  const url = new URL(request.url);
  const workStore: WorkStore = {
    isStaticGeneration: false,
    page: url.pathname,
    route: url.pathname,
    forceStatic: false,
    dynamicShouldError: false,
    afterContext: {
      after(task) {
        void task();
      },
    },
  };
  const requestStore: RequestStore = {
    type: "request",
    phase: "render",
    implicitTags: { tags: [] },
    url: { pathname: url.pathname, search: url.search },
    headers: sealedHeaders,
    cookies: sealedCookies,
    mutableCookies: sealedCookies,
    userspaceMutableCookies: sealedCookies,
    rootParams: {},
    renderResumeDataCache: null,
    draftMode: { isEnabled: false },
  };
  const pending: Promise<unknown>[] = [];
  workStore.afterContext.after = (task) => {
    pending.push(Promise.resolve().then(task));
  };
  const result = await workAsyncStorage.run(workStore, () =>
    workUnitAsyncStorage.run(requestStore, run),
  );
  await Promise.all(pending);
  return result;
}

function navigationHeaders(cookie: string | null, origin: string | null): Headers {
  const headers = new Headers({
    "sec-fetch-site": "cross-site",
    "sec-fetch-mode": "navigate",
    "sec-fetch-dest": "document",
    "sec-fetch-user": "?1",
    accept: "text/html,application/xhtml+xml",
  });
  if (cookie) headers.set("cookie", cookie);
  if (origin) headers.set("origin", origin);
  return headers;
}

type Handler = (request: Request) => Promise<Response>;

type Case = {
  name: string;
  email: string;
  path: string;
  cookie: string | null;
  origin: string | null;
  expectAnonymous: boolean;
  prepare?: () => Promise<void>;
  invoke: Handler;
};

async function runCase(testCase: Case): Promise<string[]> {
  await seedStaleCaches(testCase.email);
  // A previous case may have filled the short-lived inbox snapshot.
  // Drop provider caches this case does not itself seed so a warm
  // snapshot cannot hide a refresh.
  await kvDelete(`inbox-snap:${testCase.email}`);
  await kvDelete(`kept-scan:${testCase.email}`);
  await kvDelete(`waiting:${testCase.email}`);
  await kvDelete(`gmail-labels:${testCase.email}`);
  if (testCase.prepare) await testCase.prepare();
  const before = await snapshotStore();
  fetchCalls.length = 0;
  const request = new Request(`${APP_ORIGIN}${testCase.path}`, {
    method: "GET",
    headers: navigationHeaders(testCase.cookie, testCase.origin),
  });
  let status = 0;
  let error = "";
  try {
    const response = await withRequest(request, () => testCase.invoke(request));
    status = response.status;
    if (status >= 500) error = (await response.text()).slice(0, 180);
  } catch (err) {
    status = 0;
    error = err instanceof Error ? err.message : String(err);
  }
  const after = await snapshotStore();
  const problems: string[] = [];
  if (testCase.expectAnonymous) {
    if (status !== 401) {
      problems.push(`${testCase.name}: anonymous GET status ${status}, expected 401`);
    }
  } else if (status === 401 || status === 0) {
    problems.push(
      `${testCase.name}: session cookie was not accepted (status ${status}${error ? `: ${error}` : ""})`,
    );
  }
  if (fetchCalls.length > 0) {
    const urls = fetchCalls
      .map((call) => `${redactUrl(call.url)} sessionToken=${call.usedSessionToken}`)
      .join(" | ");
    problems.push(`${testCase.name}: provider or other fetch ran: ${urls}`);
  }
  if (before !== after) {
    problems.push(`${testCase.name}: cross-site GET changed the key-value store`);
  }
  return problems;
}

async function startLocalDb(): Promise<{ stop: () => Promise<void> }> {
  const admin = new Pool({
    host: "127.0.0.1",
    port: 5432,
    user: "postgres",
    password: DB_PASSWORD,
    database: "postgres",
  });
  await admin.query(`drop database if exists ${DB_NAME}`);
  await admin.query(`create database ${DB_NAME}`);
  const pool = new Pool({
    host: "127.0.0.1",
    port: 5432,
    user: "postgres",
    password: DB_PASSWORD,
    database: DB_NAME,
  });
  await pool.query(
    "do $$ begin create role anon nologin; exception when duplicate_object then null; end $$",
  );
  await pool.query(
    "do $$ begin create role authenticated nologin; exception when duplicate_object then null; end $$",
  );
  const migrationsDir = path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    "..",
    "supabase",
    "migrations",
  );
  const files = (await fs.readdir(migrationsDir))
    .filter((name) => name.endsWith(".sql"))
    .sort();
  for (const file of files) {
    const sql = await fs.readFile(path.join(migrationsDir, file), "utf8");
    await pool.query(sql);
  }
  setPoolForTesting(pool);
  return {
    stop: async () => {
      setPoolForTesting(null);
      await pool.end();
      await admin.query(`drop database if exists ${DB_NAME}`);
      await admin.end();
    },
  };
}

async function main(): Promise<void> {
  installFetchStandIn();
  const db = await startLocalDb();
  try {
    const googleUser = await upsertUser(GOOGLE_EMAIL);
    const microsoftUser = await upsertUser(MICROSOFT_EMAIL);
    const expiresAt = Date.now() + 60 * 60 * 1000;
    await upsertAccountWithCredentials({
      userId: googleUser,
      provider: "google",
      email: GOOGLE_EMAIL,
      displayName: "Victim",
      accessToken: PLACEHOLDER_TOKEN,
      expiresAt,
    });
    await upsertAccountWithCredentials({
      userId: microsoftUser,
      provider: "microsoft",
      email: MICROSOFT_EMAIL,
      displayName: "Victim",
      accessToken: PLACEHOLDER_TOKEN,
      expiresAt,
    });

    const googleCookie = await sessionCookie({
      email: GOOGLE_EMAIL,
      provider: "google",
    });
    const microsoftCookie = await sessionCookie({
      email: MICROSOFT_EMAIL,
      provider: "microsoft-entra-id",
    });

    const contacts = (await import("../src/app/api/contacts/route.ts")).GET;
    const vips = (await import("../src/app/api/vips/route.ts")).GET;
    const alltasks = (await import("../src/app/api/alltasks/route.ts")).GET;
    const mailbox = (await import("../src/app/api/mailbox/route.ts")).GET;
    const today = (await import("../src/app/api/today/route.ts")).GET;
    const message = (await import("../src/app/api/messages/[id]/route.ts")).GET;
    const attachment = (
      await import("../src/app/api/messages/[id]/attachment/route.ts")
    ).GET;
    const samples = (await import("../src/app/api/classifier/samples/route.ts")).GET;
    const catchup = (await import("../src/app/api/catchup/route.ts")).GET;
    const unsub = (await import("../src/app/api/unsub-agent/route.ts")).GET;
    const health = (await import("../src/app/api/health/route.ts")).GET;
    const waiting = (await import("../src/app/api/waiting/route.ts")).GET;
    const legacyMail = (await import("../src/app/api/mail/route.ts")).GET;

    const messageParams = { params: Promise.resolve({ id: "msg-1" }) };
    const cases: Case[] = [
      {
        name: "contacts navigation without Origin, google, stale caches, q set",
        email: GOOGLE_EMAIL,
        path: "/api/contacts?q=ada",
        cookie: googleCookie,
        origin: null,
        expectAnonymous: false,
        invoke: contacts,
      },
      {
        name: "contacts navigation with attacker Origin, google, stale caches",
        email: GOOGLE_EMAIL,
        path: "/api/contacts?q=ada",
        cookie: googleCookie,
        origin: ATTACKER_ORIGIN,
        expectAnonymous: false,
        invoke: contacts,
      },
      {
        name: "contacts navigation without Origin, microsoft, stale caches",
        email: MICROSOFT_EMAIL,
        path: "/api/contacts?q=ada",
        cookie: microsoftCookie,
        origin: null,
        expectAnonymous: false,
        invoke: contacts,
      },
      {
        name: "vips navigation",
        email: GOOGLE_EMAIL,
        path: "/api/vips",
        cookie: googleCookie,
        origin: null,
        expectAnonymous: false,
        invoke: vips,
      },
      {
        name: "alltasks navigation",
        email: GOOGLE_EMAIL,
        path: "/api/alltasks",
        cookie: googleCookie,
        origin: null,
        expectAnonymous: false,
        invoke: alltasks,
      },
      {
        name: "mailbox navigation",
        email: GOOGLE_EMAIL,
        path: "/api/mailbox",
        cookie: googleCookie,
        origin: null,
        expectAnonymous: false,
        invoke: mailbox,
      },
      {
        name: "today navigation",
        email: GOOGLE_EMAIL,
        path: "/api/today",
        cookie: googleCookie,
        origin: null,
        expectAnonymous: false,
        invoke: today,
      },
      {
        name: "message navigation",
        email: GOOGLE_EMAIL,
        path: "/api/messages/msg-1",
        cookie: googleCookie,
        origin: null,
        expectAnonymous: false,
        invoke: (request) => message(request, messageParams),
      },
      {
        name: "attachment navigation",
        email: GOOGLE_EMAIL,
        path: "/api/messages/msg-1/attachment?aid=placeholder-attachment",
        cookie: googleCookie,
        origin: null,
        expectAnonymous: false,
        invoke: (request) => attachment(request, messageParams),
      },
      {
        name: "classifier samples navigation",
        email: GOOGLE_EMAIL,
        path: "/api/classifier/samples",
        cookie: googleCookie,
        origin: null,
        expectAnonymous: false,
        invoke: samples,
      },
      {
        name: "catchup navigation after the mailbox was opened",
        email: GOOGLE_EMAIL,
        path: "/api/catchup",
        cookie: googleCookie,
        origin: null,
        expectAnonymous: false,
        prepare: async () => {
          await kvSet(
            `last-open:${GOOGLE_EMAIL}`,
            new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
          );
        },
        invoke: catchup,
      },
      {
        name: "unsubscribe agent navigation when the assistant is configured",
        email: GOOGLE_EMAIL,
        path: "/api/unsub-agent",
        cookie: googleCookie,
        origin: null,
        expectAnonymous: false,
        prepare: async () => {
          process.env.VERCEL = "1";
        },
        invoke: async (request) => {
          try {
            return await unsub(request);
          } finally {
            delete process.env.VERCEL;
          }
        },
      },
      {
        name: "health navigation",
        email: GOOGLE_EMAIL,
        path: "/api/health",
        cookie: googleCookie,
        origin: null,
        expectAnonymous: false,
        invoke: health,
      },
      {
        name: "waiting navigation with a stale sent-mail cache",
        email: GOOGLE_EMAIL,
        path: "/api/waiting",
        cookie: googleCookie,
        origin: null,
        expectAnonymous: false,
        invoke: waiting,
      },
      {
        name: "anonymous contacts navigation",
        email: GOOGLE_EMAIL,
        path: "/api/contacts?q=ada",
        cookie: null,
        origin: ATTACKER_ORIGIN,
        expectAnonymous: true,
        invoke: contacts,
      },
      {
        name: "legacy /api/mail navigation does not read the v3 credential",
        email: GOOGLE_EMAIL,
        path: "/api/mail",
        cookie: googleCookie,
        origin: null,
        expectAnonymous: true,
        invoke: legacyMail,
      },
    ];

    const problems: string[] = [];
    for (const testCase of cases) {
      problems.push(...(await runCase(testCase)));
    }

    const personal = await kvGet<unknown>(`personal:${GOOGLE_EMAIL}`);
    assert.ok(personal, "stale personal cache must exist for the assertions above");
    assert.deepEqual(problems, []);
  } finally {
    await db.stop();
    await fs.rm(process.env.SEER_DATA_DIR!, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
