/**
 * Cross-site GET /api/v2/mailbox-style must not write seer.mailbox_styles.
 *
 * These assertions fail while the refresh stays on GET. They pass when GET is
 * read-only and only a same-origin POST refreshes an unconfirmed style.
 */
import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";
import { encode } from "@auth/core/jwt";
import { startTestDb } from "./v2-testdb.mts";
import { upsertAccount, upsertUser } from "../src/lib/v2/db/accounts.ts";
import { asConversationId } from "../src/lib/v2/db/types.ts";
import { executeCommand } from "../src/lib/v2/commands/execute.ts";
import { clearContextInputCache } from "../src/lib/v2/intelligence/context-loader.ts";
import { compileContext } from "../src/lib/v2/intelligence/context.ts";
import { CHIEF_OF_STAFF_SYSTEM } from "../src/lib/v2/intelligence/model.ts";
import type { Conversation } from "../src/lib/v2/providers/types.ts";

const AUTH_SECRET = "mailbox-style-test-auth-secret";
const APP_ORIGIN = "https://app.example";
const SESSION_COOKIE = "__Secure-authjs.session-token";

process.env.AUTH_SECRET = AUTH_SECRET;
process.env.AUTH_URL = APP_ORIGIN;
process.env.NODE_ENV = "production";
process.env.VERCEL_ENV = "production";
delete process.env.SEER_ALLOWED_ORIGIN;

if (!globalThis.AsyncLocalStorage) {
  globalThis.AsyncLocalStorage = AsyncLocalStorage;
}

type StyleSnapshot = {
  account_id: string;
  clear_habit: string;
  importance_cues: string[];
  matter_bar: string;
  confirmed: boolean;
  inferred: string;
  drift_prompt: string | null;
  confirmed_at: string | null;
  updated_at: string;
};

type RouteCall = {
  method: "GET" | "POST";
  origin: string | null;
  secFetchSite?: "cross-site" | "same-origin";
  referer?: string;
  cookie: string;
  search?: string;
  body?: unknown;
};

const db = await startTestDb();
try {
  const victimEmail = "victim-style@rditrials.com";
  const bystanderEmail = "bystander-style@rditrials.com";
  const confirmedEmail = "confirmed-style@rditrials.com";
  const mediumEmail = "medium-style@rditrials.com";
  const victimUser = await upsertUser(victimEmail);
  const bystanderUser = await upsertUser(bystanderEmail);
  const confirmedUser = await upsertUser(confirmedEmail);
  const mediumUser = await upsertUser(mediumEmail);
  const victimId = await upsertAccount({
    userId: victimUser,
    provider: "google",
    email: victimEmail,
  });
  const bystanderId = await upsertAccount({
    userId: bystanderUser,
    provider: "google",
    email: bystanderEmail,
  });
  const confirmedId = await upsertAccount({
    userId: confirmedUser,
    provider: "google",
    email: confirmedEmail,
  });
  const mediumId = await upsertAccount({
    userId: mediumUser,
    provider: "google",
    email: mediumEmail,
  });

  await db.pool.query(
    `insert into seer.folder_sync_state
       (account_id, folder, provider_total, backfill_complete)
     values ($1, 'inbox', 2500, true),
            ($2, 'inbox', 800, true)`,
    [victimId, bystanderId],
  );
  await db.pool.query(
    `insert into seer.folder_sync_state
       (account_id, folder, provider_total, backfill_complete)
     values ($1, 'inbox', 2500, true)`,
    [confirmedId],
  );
  await db.pool.query(
    `insert into seer.mailbox_styles
       (account_id, clear_habit, importance_cues, matter_bar, confirmed, inferred, confirmed_at)
     values ($1, 'archive', array['none']::text[], 'medium', true,
             '{"clearHabit":"archive","importanceCues":["none"],"matterBar":"medium","confidence":0.5,"reasons":["kept"]}'::jsonb,
             now())`,
    [confirmedId],
  );
  await db.pool.query(
    `insert into seer.folder_sync_state
       (account_id, folder, provider_total, backfill_complete)
     values ($1, 'inbox', 800, true)`,
    [mediumId],
  );
  await db.pool.query(
    `insert into seer.mailbox_styles
       (account_id, clear_habit, importance_cues, matter_bar, confirmed, inferred)
     values ($1, 'archive', array['none']::text[], 'medium', false,
             '{"clearHabit":"archive","importanceCues":["none"],"matterBar":"medium","confidence":0.5,"reasons":[]}'::jsonb)`,
    [mediumId],
  );
  await db.pool.query(
    `insert into seer.conversations
       (account_id, provider_conversation_id, subject, folders, is_unread)
     select $1, 'stored-' || g, 'Stored', array['inbox'], true
       from generate_series(1, 40) g`,
    [victimId],
  );
  await db.pool.query(
    `insert into seer.mailbox_styles
       (account_id, clear_habit, importance_cues, matter_bar, confirmed, inferred)
     values ($1, 'archive', array['none']::text[], 'medium', false,
             '{"clearHabit":"archive","importanceCues":["none"],"matterBar":"medium","confidence":0.5,"reasons":[]}'::jsonb)`,
    [bystanderId],
  );

  const triage = await db.pool.query<{ id: string }>(
    `insert into seer.conversations
       (account_id, provider_conversation_id, subject, folders, is_unread)
     values ($1, 'triage-thread', 'Needs clearing', array['inbox'], true)
     returning id`,
    [victimId],
  );
  const relevance = await db.pool.query<{ id: string }>(
    `insert into seer.conversations
       (account_id, provider_conversation_id, subject, folders, is_unread)
     values ($1, 'relevance-thread', 'Done thread', array['inbox'], true)
     returning id`,
    [victimId],
  );
  const triageId = asConversationId(triage.rows[0].id);
  const relevanceId = asConversationId(relevance.rows[0].id);

  const cookie = [
    await sessionToken(victimEmail, victimId),
    `seer_active_account=${bystanderId}`,
  ].join("; ");
  const confirmedCookie = await sessionToken(confirmedEmail, confirmedId);
  const mediumCookie = await sessionToken(mediumEmail, mediumId);

  const before = await snapshot();

  const { middleware } = await import("../src/middleware.ts");
  const { NextRequest } = await import("next/server");
  const navigation = new NextRequest(
    `${APP_ORIGIN}/api/v2/mailbox-style?accountId=${bystanderId}`,
    {
      headers: {
        host: "app.example",
        cookie,
        "sec-fetch-site": "cross-site",
        "sec-fetch-mode": "navigate",
        "sec-fetch-dest": "document",
        "sec-fetch-user": "?1",
      },
    },
  );
  const passed = middleware(navigation);
  assert.equal(passed.status, 200);
  assert.equal(passed.headers.get("location"), null);

  const { getActiveV2Account } = await import("../src/lib/v2/session.ts");
  const signedIn = await inRequest(
    {
      method: "GET",
      origin: null,
      secFetchSite: "cross-site",
      cookie,
      search: `?accountId=${bystanderId}`,
    },
    () => getActiveV2Account(),
  );
  assert.equal(signedIn?.id, victimId);
  assert.equal(signedIn?.email, victimEmail);

  const crossSite = await callRoute({
    method: "GET",
    origin: null,
    referer: "https://evil.example/attack",
    cookie,
    search: `?accountId=${bystanderId}`,
  });
  assert.notEqual(
    crossSite.status,
    404,
    "a signed-in cross-site navigation must reach the mailbox-style route",
  );
  assert.deepEqual(
    await snapshot(),
    before,
    "cross-site GET navigation must not insert or update seer.mailbox_styles",
  );

  const mediumGet = await callRoute({
    method: "GET",
    origin: null,
    referer: "https://evil.example/attack",
    cookie: mediumCookie,
  });
  assert.notEqual(mediumGet.status, 404);
  assert.equal(
    (await snapshot()).find((row) => row.account_id === mediumId)?.clear_habit,
    "archive",
    "an 800-conversation inbox with fewer than five clears must not be rewritten to leave by a cross-site GET",
  );

  const confirmedGet = await callRoute({
    method: "GET",
    origin: null,
    referer: "https://evil.example/attack",
    cookie: confirmedCookie,
  });
  assert.notEqual(confirmedGet.status, 404);
  assert.deepEqual(
    await snapshot(),
    before,
    "cross-site GET must not rewrite a confirmed style or its inference blob",
  );

  const evilOrigin = await callRoute({
    method: "GET",
    origin: "https://evil.example",
    secFetchSite: "cross-site",
    cookie,
    search: `?accountId=${bystanderId}`,
  });
  assert.notEqual(evilOrigin.status, 404);
  assert.deepEqual(
    await snapshot(),
    before,
    "a cross-site Origin on GET must not write seer.mailbox_styles",
  );

  const sameOriginGet = await callRoute({
    method: "GET",
    origin: APP_ORIGIN,
    secFetchSite: "same-origin",
    cookie,
  });
  assert.notEqual(sameOriginGet.status, 404);
  assert.deepEqual(
    await snapshot(),
    before,
    "GET stays read-only even when Origin matches the app",
  );

  clearContextInputCache();
  const { loadContextInput } = await import(
    "../src/lib/v2/intelligence/context-loader.ts"
  );
  const contextAfterGet = compileContext(
    sampleConversation(),
    await loadContextInput(victimId, victimEmail),
  );
  const modelPrompt = JSON.stringify({
    context: contextAfterGet.text || "no prior relationship on record",
  });
  assert.equal(
    CHIEF_OF_STAFF_SYSTEM.includes(
      "[explicit]/[system] outrank your reading",
    ),
    true,
  );
  assert.equal(
    modelPrompt.includes("leave mail in the Inbox folder"),
    false,
    "a cross-site GET must not become the chief-of-staff explicit habit line",
  );

  const triaged = await executeCommand(
    { accountId: victimId },
    { type: "triageConversation", conversationId: triageId, destination: "archive" },
    "csrf-triage-archive",
  );
  assert.equal(triaged.ok, true);
  assert.ok(triaged.outboxId, "unconfirmed style must still archive on triage");
  const trained = await executeCommand(
    { accountId: victimId },
    {
      type: "trainRelevance",
      conversationId: relevanceId,
      relevant: false,
      reason: "taken_care_of",
    },
    "csrf-relevance-archive",
  );
  assert.equal(trained.ok, true);
  assert.ok(
    trained.outboxId,
    "unconfirmed style must still archive on relevance",
  );

  const nullOrigin = await callRoute({
    method: "POST",
    origin: "null",
    secFetchSite: "cross-site",
    cookie,
    body: { accountId: bystanderId },
  });
  assert.equal(nullOrigin.status, 403);
  assert.deepEqual(await snapshot(), before);

  const crossSitePost = await callRoute({
    method: "POST",
    origin: "https://evil.example",
    secFetchSite: "cross-site",
    cookie,
    body: { accountId: bystanderId },
  });
  assert.equal(crossSitePost.status, 403);
  assert.deepEqual(
    await snapshot(),
    before,
    "a cross-site POST must not write before or after refusing",
  );

  const missingOrigin = await callRoute({
    method: "POST",
    origin: null,
    secFetchSite: "cross-site",
    cookie,
    body: { accountId: bystanderId },
  });
  assert.equal(missingOrigin.status, 403);
  assert.deepEqual(await snapshot(), before);

  const refreshed = await callRoute({
    method: "POST",
    origin: APP_ORIGIN,
    secFetchSite: "same-origin",
    cookie,
    body: { accountId: bystanderId },
  });
  assert.equal(refreshed.status, 200);
  const afterPost = await snapshot();
  const victim = afterPost.find((row) => row.account_id === victimId);
  const bystander = afterPost.find((row) => row.account_id === bystanderId);
  assert.ok(victim);
  assert.equal(victim.clear_habit, "leave");
  assert.equal(victim.confirmed, false);
  assert.deepEqual(victim.importance_cues, ["unread"]);
  assert.equal(victim.matter_bar, "high");
  assert.equal(bystander?.clear_habit, "archive");
  assert.equal(bystander?.confirmed, false);
  assert.equal(bystander?.updated_at, before.find((row) => row.account_id === bystanderId)?.updated_at);

  clearContextInputCache();
  const contextAfterPost = compileContext(
    sampleConversation(),
    await loadContextInput(victimId, victimEmail),
  );
  assert.match(
    contextAfterPost.text,
    /\[explicit\] how this person uses mail \(user\): they leave mail in the Inbox folder/,
  );
  const confirmedRow = (await snapshot()).find((row) => row.account_id === confirmedId);
  assert.equal(confirmedRow?.clear_habit, "archive");
  assert.equal(confirmedRow?.confirmed, true);
  assert.equal(
    confirmedRow?.updated_at,
    before.find((row) => row.account_id === confirmedId)?.updated_at,
  );

  console.log("mailbox-style-get-csrf: OK");
} finally {
  await db.stop();
}

async function sessionToken(email: string, accountId: string): Promise<string> {
  const token = await encode({
    salt: SESSION_COOKIE,
    secret: AUTH_SECRET,
    token: {
      email,
      sub: email,
      name: email,
      activeAccountId: accountId,
    },
  });
  return `${SESSION_COOKIE}=${token}`;
}

async function snapshot(): Promise<StyleSnapshot[]> {
  const result = await db.pool.query<StyleSnapshot>(
    `select account_id::text,
            clear_habit,
            importance_cues,
            matter_bar,
            confirmed,
            inferred::text,
            drift_prompt,
            confirmed_at::text,
            updated_at::text
       from seer.mailbox_styles
      order by account_id`,
  );
  return result.rows;
}

function sampleConversation(): Conversation {
  return {
    providerConversationId: "thread",
    subject: "Status",
    lastMessageAt: "2026-11-01T00:00:00.000Z",
    messages: [
      {
        providerMessageId: "m1",
        from: { email: "other@example.com", name: "Other" },
        to: [{ email: "victim-style@rditrials.com" }],
        cc: [],
        sentAt: "2026-11-01T00:00:00.000Z",
        snippet: "hello",
        bodyHtml: null,
        bodyText: "hello",
        isUnread: true,
        isOutgoing: false,
        attachments: [],
      },
    ],
  };
}

async function callRoute(input: RouteCall): Promise<Response> {
  const route = await import("../src/app/api/v2/mailbox-style/route.ts");
  const handler = route[input.method] as
    | ((request: Request) => Promise<Response>)
    | undefined;
  assert.equal(
    typeof handler,
    "function",
    `${input.method} /api/v2/mailbox-style must be a route handler`,
  );
  return inRequest(input, () => handler!(requestFor(input)));
}

function requestFor(input: RouteCall): Request {
  const headers = headersFor(input);
  return new Request(
    `${APP_ORIGIN}/api/v2/mailbox-style${input.search ?? ""}`,
    {
      method: input.method,
      headers,
      body: input.method === "POST" ? JSON.stringify(input.body ?? {}) : undefined,
    },
  );
}

function headersFor(input: RouteCall): Headers {
  const headers = new Headers();
  headers.set("host", "app.example");
  headers.set("x-forwarded-proto", "https");
  headers.set("cookie", input.cookie);
  if (input.secFetchSite) {
    headers.set("sec-fetch-site", input.secFetchSite);
    headers.set(
      "sec-fetch-mode",
      input.method === "GET" ? "navigate" : "cors",
    );
    headers.set(
      "sec-fetch-dest",
      input.method === "GET" ? "document" : "empty",
    );
    if (input.method === "GET") headers.set("sec-fetch-user", "?1");
  }
  if (input.referer) headers.set("referer", input.referer);
  if (input.origin) headers.set("origin", input.origin);
  if (input.method === "POST") headers.set("content-type", "application/json");
  return headers;
}

async function inRequest<T>(
  input: RouteCall,
  run: () => Promise<T>,
): Promise<T> {
  const { workAsyncStorage } = await import(
    "next/dist/server/app-render/work-async-storage.external.js"
  );
  const { workUnitAsyncStorage } = await import(
    "next/dist/server/app-render/work-unit-async-storage.external.js"
  );
  const { HeadersAdapter } = await import(
    "next/dist/server/web/spec-extension/adapters/headers.js"
  );
  const { RequestCookies } = await import(
    "next/dist/server/web/spec-extension/cookies.js"
  );
  const { RequestCookiesAdapter } = await import(
    "next/dist/server/web/spec-extension/adapters/request-cookies.js"
  );
  const headers = headersFor(input);
  const workStore = {
    isStaticGeneration: false,
    page: "/api/v2/mailbox-style/route",
    route: "/api/v2/mailbox-style",
    forceStatic: false,
    dynamicShouldError: false,
    afterContext: { waitUntil() {} },
    previouslyRevalidatedTags: [],
    refreshTagsByCacheKind: new Map(),
    shouldTrackFetchMetrics: false,
    buildId: "test",
    cacheComponentsEnabled: false,
    dev: false,
  };
  const workUnitStore = {
    type: "request",
    phase: "render",
    implicitTags: { headers: new Headers() },
    url: { pathname: "/api/v2/mailbox-style", search: input.search ?? "" },
    headers: HeadersAdapter.seal(headers),
    cookies: RequestCookiesAdapter.seal(new RequestCookies(headers)),
    mutableCookies: RequestCookiesAdapter.seal(new RequestCookies(headers)),
    userspaceMutableCookies: RequestCookiesAdapter.seal(new RequestCookies(headers)),
    rootParams: {},
    renderResumeDataCache: null,
  };
  return workAsyncStorage.run(workStore, () =>
    workUnitAsyncStorage.run(workUnitStore, run),
  );
}
