/**
 * A revoked Google or Microsoft grant must not keep a v2 session able to read
 * the synced mailbox or the Seer intelligence stored for it.
 *
 * The session cookie is an Auth.js JWT. These tests issue one the same way
 * Auth.js does, run the real jwt and session callbacks through the session
 * endpoint, then call the corpus routes with the cookie that endpoint
 * reissues. Provider token endpoints are stubbed with the error shape
 * refreshGoogle / refreshMicrosoft already treat as a failed refresh.
 *
 * A passing run means those routes refuse. They fail while a failed refresh,
 * a reconnect_required credential, or a session error still resolves an
 * account and the handlers return that account's corpus.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { AsyncLocalStorage } from "node:async_hooks";
import os from "node:os";
import path from "node:path";
import type { Pool } from "pg";

if (typeof globalThis.AsyncLocalStorage !== "function") {
  globalThis.AsyncLocalStorage = AsyncLocalStorage;
}

const AUTH_SECRET_PLACEHOLDER = "test-auth-secret-placeholder";
const SESSION_COOKIE = "authjs.session-token";
const ACTIVE_ACCOUNT_COOKIE = "seer_active_account";
/** Longest session lifetime that still matches a re-check within a few hours. */
const MAX_SESSION_MS = 4 * 60 * 60 * 1000;

process.env.AUTH_SECRET = AUTH_SECRET_PLACEHOLDER;
process.env.AUTH_URL = "http://localhost:3000";
process.env.AUTH_GOOGLE_ID = "test-google-client-id";
process.env.AUTH_GOOGLE_SECRET = "test-google-client-secret-placeholder";
process.env.AUTH_MICROSOFT_ENTRA_ID_ID = "test-microsoft-client-id";
process.env.AUTH_MICROSOFT_ENTRA_ID_SECRET = "test-microsoft-client-secret-placeholder";
process.env.AUTH_MICROSOFT_ENTRA_ID_ISSUER =
  "https://login.microsoftonline.com/test-tenant/v2.0";
process.env.SEER_DATA_DIR = await mkdtemp(path.join(os.tmpdir(), "seer-revoked-"));
delete process.env.POSTGRES_URL;
delete process.env.UPSTASH_REDIS_REST_URL;
delete process.env.KV_REST_API_URL;

type FetchCall = { url: string; status: number };

const fetchCalls: FetchCall[] = [];
const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
  if (url === "https://oauth2.googleapis.com/token") {
    fetchCalls.push({ url, status: 400 });
    return new Response(
      JSON.stringify({ error: "invalid_grant", error_description: "revoked" }),
      { status: 400, headers: { "content-type": "application/json" } },
    );
  }
  if (/^https:\/\/login\.microsoftonline\.com\/[^/]+\/oauth2\/v2\.0\/token$/.test(url)) {
    fetchCalls.push({ url, status: 400 });
    return new Response(JSON.stringify({ error: "invalid_grant" }), {
      status: 400,
      headers: { "content-type": "application/json" },
    });
  }
  throw new Error(`unexpected outbound request during revoked-grant test: ${url}`);
};

const { startTestDb } = await import("./v2-testdb.mts");
const accounts = await import("../src/lib/v2/db/accounts.ts");
const { encode } = await import("@auth/core/jwt");
const { handlers } = await import("../src/auth.ts");
await import("next/dist/server/node-environment-baseline.js");
const { createRequestStoreForAPI } = await import(
  "next/dist/server/async-storage/request-store.js"
);
const { workAsyncStorage } = await import(
  "next/dist/server/app-render/work-async-storage.external.js"
);
const { workUnitAsyncStorage } = await import(
  "next/dist/server/app-render/work-unit-async-storage.external.js"
);
const mailboxRoute = await import("../src/app/api/v3/mailbox/route.ts");
const conversationRoute = await import("../src/app/api/v3/conversations/[id]/route.ts");
const inboxRoute = await import("../src/app/api/v2/inbox/route.ts");
const contactsRoute = await import("../src/app/api/v3/contacts/route.ts");
const mattersRoute = await import("../src/app/api/v3/matter-suggestions/route.ts");
const operatingRoute = await import("../src/app/api/v2/operating-model/route.ts");
const staffRoute = await import("../src/app/api/v2/staff/route.ts");
const styleRoute = await import("../src/app/api/v2/mailbox-style/route.ts");
const commandsRoute = await import("../src/app/api/v2/commands/route.ts");
const undoRoute = await import("../src/app/api/v3/outbox/[id]/undo/route.ts");

type MailProviderKind = "google" | "microsoft";

type Corpus = {
  accountId: string;
  conversationId: string;
  subject: string;
  body: string;
  summary: string;
  matterTitle: string;
  contact: string;
  guidance: string;
  taskTitle: string;
};

const failures: string[] = [];

function expectSecure(condition: unknown, message: string) {
  if (!condition) failures.push(message);
}

function refused(status: number): boolean {
  return status === 401 || status === 403 || status === 404;
}

async function inRequest<T>(cookieHeader: string, run: () => Promise<T>): Promise<T> {
  const req = {
    headers: {
      cookie: cookieHeader,
      host: "localhost:3000",
      "x-forwarded-proto": "http",
    },
  };
  const url = new URL("http://localhost:3000/api/v3/mailbox");
  const requestStore = createRequestStoreForAPI(
    req,
    url,
    { tags: [] },
    undefined,
    {
      previewModeId: "test-preview",
      previewModeEncryptionKey: "test-preview-encryption",
      previewModeSigningKey: "test-preview-signing",
    },
  );
  const workStore = {
    route: "/api/v3/mailbox",
    forceStatic: false,
    dynamicShouldError: false,
    // Next's after() stores work on this context and runs it once the response
    // has been returned. The test records that registration and does not run
    // the deferred provider drain as part of the response.
    afterContext: {
      after() {
        return undefined;
      },
    },
  };
  return workUnitAsyncStorage.run(requestStore, () =>
    workAsyncStorage.run(workStore, run),
  );
}

async function sessionJwt(payload: Record<string, unknown>): Promise<string> {
  return encode({
    token: payload,
    secret: AUTH_SECRET_PLACEHOLDER,
    salt: SESSION_COOKIE,
    maxAge: 30 * 24 * 60 * 60,
  });
}

function cookieExpiry(setCookie: string): Date | null {
  const parts = setCookie.split(";").map((part) => part.trim());
  const exp = parts.find((part) => part.toLowerCase().startsWith("expires="));
  if (!exp) return null;
  const date = new Date(exp.slice(exp.indexOf("=") + 1));
  return Number.isNaN(date.getTime()) ? null : date;
}

async function readSession(token: string, extraCookie = ""): Promise<{
  status: number;
  body: { user?: { email?: string }; error?: string };
  cookie: string;
  expires: Date | null;
}> {
  const cookie = [`${SESSION_COOKIE}=${token}`, extraCookie].filter(Boolean).join("; ");
  const sessionUrl = new URL("http://localhost:3000/api/auth/session");
  const sessionRequest = new Request(sessionUrl, {
    headers: {
      cookie,
      host: "localhost:3000",
      "x-forwarded-proto": "http",
    },
  });
  Object.defineProperty(sessionRequest, "nextUrl", { value: sessionUrl });
  const response = await handlers.GET(sessionRequest);
  const text = await response.text();
  let body: { user?: { email?: string }; error?: string } = {};
  if (text) {
    try {
      body = JSON.parse(text) as typeof body;
    } catch {
      body = {};
    }
  }
  let renewed: string | null = null;
  let expires: Date | null = null;
  for (const row of response.headers.getSetCookie()) {
    const pair = row.split(";")[0]?.trim() ?? "";
    const eq = pair.indexOf("=");
    if (eq < 0) continue;
    const name = pair.slice(0, eq);
    const value = pair.slice(eq + 1);
    if (name === SESSION_COOKIE && value) {
      renewed = `${name}=${value}`;
      expires = cookieExpiry(row);
    }
  }
  return {
    status: response.status,
    body,
    cookie: [renewed ?? `${SESSION_COOKIE}=${token}`, extraCookie].filter(Boolean).join("; "),
    expires,
  };
}

async function call(
  cookie: string,
  request: Request,
  invoke: (request: Request) => Promise<Response>,
): Promise<{ status: number; body: string }> {
  const response = await inRequest(cookie, () => invoke(request));
  return { status: response.status, body: await response.text() };
}

async function seedCorpus(
  pool: Pool,
  input: {
    userId: string;
    provider: MailProviderKind;
    email: string;
    marker: string;
    accessExpiresAt: number;
    status?: "active" | "reconnect_required";
  },
): Promise<Corpus> {
  const saved = await accounts.upsertAccountWithCredentials({
    userId: input.userId as never,
    provider: input.provider,
    email: input.email,
    displayName: input.email,
    accessToken: "access-token-placeholder",
    refreshToken: "refresh-token-placeholder",
    expiresAt: input.accessExpiresAt,
  });
  if (input.status === "reconnect_required") {
    await accounts.markCredentialsReconnectRequired(saved.id, "revoked");
  }
  const subject = `${input.marker} subject`;
  const body = `${input.marker} body`;
  const summary = `${input.marker} decision`;
  const matterTitle = `${input.marker} matter`;
  const contact = `${input.marker}@counterparty.example`;
  const guidance = `${input.marker} guidance`;
  const taskTitle = `${input.marker} task`;
  const conversation = await pool.query<{ id: string }>(
    `insert into seer.conversations
       (account_id, provider_conversation_id, subject, last_message_at, folders, is_unread)
     values ($1, $2, $3, now(), array['inbox']::text[], true)
     returning id`,
    [saved.id, `${input.marker}-thread`, subject],
  );
  const conversationId = conversation.rows[0].id;
  await pool.query(
    `insert into seer.messages
       (account_id, conversation_id, provider_message_id, from_email, from_name,
        to_emails, sent_at, snippet, body_text, is_unread, is_outgoing)
     values ($1, $2, $3, $4, 'Counterparty', array[$5], now(), $6, $7, true, false)`,
    [saved.id, conversationId, `${input.marker}-message`, contact, input.email, body, body],
  );
  await pool.query(
    `insert into seer.conversation_decisions
       (account_id, conversation_id, home, proposed_home, summary, rationale,
        owner, veto_reasons, model_version, context_version, is_current, decided_at)
     values ($1, $2, 'undecided', 'matter', $3, 'test', 'you', '{}', 'test', 'test', true, now())`,
    [saved.id, conversationId, summary],
  );
  await pool.query(
    `insert into seer.matters (account_id, title, short_title, org_unit)
     values ($1, $2, $2, 'operations')`,
    [saved.id, matterTitle],
  );
  await pool.query(
    `insert into seer.operating_models (account_id, guidance)
     values ($1, $2)`,
    [saved.id, guidance],
  );
  const bot = await pool.query<{ id: string }>(
    `insert into seer.bots (slug, display_name)
     values ($1, 'Test bot')
     on conflict (slug) do update set display_name = excluded.display_name
     returning id`,
    [`bot-${input.marker}`],
  );
  await pool.query(
    `insert into seer.bot_tasks (account_id, bot_id, title, source)
     values ($1, $2, $3, 'user')`,
    [saved.id, bot.rows[0].id, taskTitle],
  );
  return {
    accountId: saved.id,
    conversationId,
    subject,
    body,
    summary,
    matterTitle,
    contact,
    guidance,
    taskTitle,
  };
}

async function expectCorpusRefused(cookie: string, corpus: Corpus, label: string) {
  const mailbox = await call(
    cookie,
    new Request("http://localhost:3000/api/v3/mailbox?folder=inbox"),
    (request) => mailboxRoute.GET(request),
  );
  expectSecure(
    refused(mailbox.status) && !mailbox.body.includes(corpus.subject),
    `${label}: GET /api/v3/mailbox returned ${mailbox.status} and ${
      mailbox.body.includes(corpus.subject) ? "included" : "omitted"
    } the synced subject`,
  );

  const conversation = await call(
    cookie,
    new Request(`http://localhost:3000/api/v3/conversations/${corpus.conversationId}`),
    (request) =>
      conversationRoute.GET(request, {
        params: Promise.resolve({ id: corpus.conversationId }),
      }),
  );
  expectSecure(
    refused(conversation.status) && !conversation.body.includes(corpus.body),
    `${label}: GET /api/v3/conversations/[id] returned ${conversation.status} and ${
      conversation.body.includes(corpus.body) ? "included" : "omitted"
    } the synced body`,
  );

  const inbox = await call(
    cookie,
    new Request("http://localhost:3000/api/v2/inbox"),
    () => inboxRoute.GET(),
  );
  expectSecure(
    refused(inbox.status) && !inbox.body.includes(corpus.summary),
    `${label}: GET /api/v2/inbox returned ${inbox.status} and ${
      inbox.body.includes(corpus.summary) ? "included" : "omitted"
    } the decision summary`,
  );

  const contacts = await call(
    cookie,
    new Request("http://localhost:3000/api/v3/contacts"),
    (request) => contactsRoute.GET(request),
  );
  expectSecure(
    refused(contacts.status) && !contacts.body.includes(corpus.contact),
    `${label}: GET /api/v3/contacts returned ${contacts.status} and ${
      contacts.body.includes(corpus.contact) ? "included" : "omitted"
    } a corpus contact`,
  );

  const matters = await call(
    cookie,
    new Request(
      `http://localhost:3000/api/v3/matter-suggestions?conversationId=${corpus.conversationId}`,
    ),
    (request) => mattersRoute.GET(request),
  );
  expectSecure(
    refused(matters.status) && !matters.body.includes(corpus.matterTitle),
    `${label}: GET /api/v3/matter-suggestions returned ${matters.status} and ${
      matters.body.includes(corpus.matterTitle) ? "included" : "omitted"
    } a matter title`,
  );

  const operating = await call(
    cookie,
    new Request("http://localhost:3000/api/v2/operating-model"),
    () => operatingRoute.GET(),
  );
  expectSecure(
    refused(operating.status) && !operating.body.includes(corpus.guidance),
    `${label}: GET /api/v2/operating-model returned ${operating.status} and ${
      operating.body.includes(corpus.guidance) ? "included" : "omitted"
    } operating guidance`,
  );

  const staff = await call(
    cookie,
    new Request("http://localhost:3000/api/v2/staff"),
    (request) => staffRoute.GET(request),
  );
  expectSecure(
    refused(staff.status) && !staff.body.includes(corpus.taskTitle),
    `${label}: GET /api/v2/staff returned ${staff.status} and ${
      staff.body.includes(corpus.taskTitle) ? "included" : "omitted"
    } a staff task`,
  );

  const stylesBefore = await count(
    "select count(*)::int as n from seer.mailbox_styles where account_id = $1",
    corpus.accountId,
  );
  const style = await call(
    cookie,
    new Request("http://localhost:3000/api/v2/mailbox-style"),
    () => styleRoute.GET(),
  );
  const stylesAfter = await count(
    "select count(*)::int as n from seer.mailbox_styles where account_id = $1",
    corpus.accountId,
  );
  expectSecure(
    refused(style.status) && stylesAfter === stylesBefore,
    `${label}: GET /api/v2/mailbox-style returned ${style.status} and mailbox_styles rows went from ${stylesBefore} to ${stylesAfter}`,
  );

  const outboxBefore = await count(
    "select count(*)::int as n from seer.outbox where account_id = $1",
    corpus.accountId,
  );
  const command = await call(
    cookie,
    new Request("http://localhost:3000/api/v2/commands", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        idempotencyKey: `${corpus.accountId}-archive`,
        withView: true,
        command: { type: "archive", conversationId: corpus.conversationId },
      }),
    }),
    (request) => commandsRoute.POST(request),
  );
  const outboxAfter = await count(
    "select count(*)::int as n from seer.outbox where account_id = $1",
    corpus.accountId,
  );
  expectSecure(
    refused(command.status) &&
      !command.body.includes(corpus.subject) &&
      outboxAfter === outboxBefore,
    `${label}: POST /api/v2/commands returned ${command.status}, ${
      command.body.includes(corpus.subject) ? "included" : "omitted"
    } the mailbox, and outbox rows went from ${outboxBefore} to ${outboxAfter}`,
  );

  await pool.query(
    `update seer.conversations
        set folders = array['archive']::text[], is_unread = true
      where id = $1 and account_id = $2`,
    [corpus.conversationId, corpus.accountId],
  );
  const seeded = await pool.query<{ id: string }>(
    `insert into seer.outbox (account_id, command, idempotency_key)
     values ($1, $2::jsonb, $3)
     returning id`,
    [
      corpus.accountId,
      JSON.stringify({
        type: "archive",
        conversationId: corpus.conversationId,
        previous: { folders: ["inbox"], isUnread: true },
        expected: { folders: ["archive"], isUnread: true },
      }),
      `${corpus.accountId}-undo-seed`,
    ],
  );
  const undo = await call(
    cookie,
    new Request(`http://localhost:3000/api/v3/outbox/${seeded.rows[0].id}/undo`, {
      method: "POST",
    }),
    (request) =>
      undoRoute.POST(request, {
        params: Promise.resolve({ id: seeded.rows[0].id }),
      }),
  );
  const undoStatus = await pool.query<{ status: string }>(
    "select status from seer.outbox where id = $1",
    [seeded.rows[0].id],
  );
  expectSecure(
    refused(undo.status) &&
      !undo.body.includes(corpus.subject) &&
      undoStatus.rows[0]?.status === "pending",
    `${label}: POST /api/v3/outbox/[id]/undo returned ${undo.status}, ${
      undo.body.includes(corpus.subject) ? "included" : "omitted"
    } the mailbox, and the pending row is ${undoStatus.rows[0]?.status ?? "missing"}`,
  );
}

let pool: Pool;
async function count(sql: string, accountId: string): Promise<number> {
  const result = await pool.query<{ n: number }>(sql, [accountId]);
  return result.rows[0].n;
}

const db = await startTestDb();
pool = db.pool;
try {
  const past = Math.floor(Date.now() / 1000) - 600;
  const future = Math.floor(Date.now() / 1000) + 3600;

  const activeUser = await accounts.upsertUser("active.employee@rditrials.com");
  const active = await seedCorpus(pool, {
    userId: activeUser,
    provider: "google",
    email: "active.employee@rditrials.com",
    marker: "active-mailbox-marker",
    accessExpiresAt: future,
  });
  const activeToken = await sessionJwt({
    email: "active.employee@rditrials.com",
    sub: "active.employee@rditrials.com",
    name: "Active",
    provider: "google",
    activeAccountId: active.accountId,
    expiresAt: future,
  });
  const activeSession = await readSession(activeToken);
  assert.equal(activeSession.status, 200, "harness: an active session must resolve");
  assert.equal(activeSession.body.user?.email, "active.employee@rditrials.com");
  const activeMailbox = await call(
    activeSession.cookie,
    new Request("http://localhost:3000/api/v3/mailbox?folder=inbox"),
    (request) => mailboxRoute.GET(request),
  );
  assert.equal(activeMailbox.status, 200, "harness: a live grant still reads its mailbox");
  assert.ok(
    activeMailbox.body.includes(active.subject),
    "harness: the live mailbox response must contain the seeded subject",
  );
  assert.ok(activeSession.expires, "harness: Auth.js reissued the session cookie");
  const activeLifetime = activeSession.expires.getTime() - Date.now();
  expectSecure(
    activeLifetime <= MAX_SESSION_MS + 120_000,
    `an active session cookie was renewed for ${Math.round(activeLifetime / 1000)}s, longer than ${MAX_SESSION_MS / 1000}s`,
  );

  const googleUser = await accounts.upsertUser("former.google@rditrials.com");
  const google = await seedCorpus(pool, {
    userId: googleUser,
    provider: "google",
    email: "former.google@rditrials.com",
    marker: "revoked-google-marker",
    accessExpiresAt: past,
  });
  const beforeGoogle = fetchCalls.length;
  const googleSession = await readSession(
    await sessionJwt({
      email: "former.google@rditrials.com",
      sub: "former.google@rditrials.com",
      name: "Former Google",
      provider: "google",
      activeAccountId: google.accountId,
      expiresAt: past,
    }),
  );
  assert.ok(
    fetchCalls.slice(beforeGoogle).some((call) => call.url === "https://oauth2.googleapis.com/token"),
    "harness: an expired Google access token must be sent to the token endpoint",
  );
  assert.equal(
    (await accounts.getOwnedAccount(googleUser, google.accountId as never))?.status,
    "reconnect_required",
    "harness: a failed Google refresh must record reconnect_required",
  );
  await expectCorpusRefused(googleSession.cookie, google, "revoked Google grant");

  const microsoftUser = await accounts.upsertUser("former.microsoft@rditrials.com");
  const microsoft = await seedCorpus(pool, {
    userId: microsoftUser,
    provider: "microsoft",
    email: "former.microsoft@rditrials.com",
    marker: "revoked-microsoft-marker",
    accessExpiresAt: past,
  });
  const beforeMicrosoft = fetchCalls.length;
  const microsoftSession = await readSession(
    await sessionJwt({
      email: "former.microsoft@rditrials.com",
      sub: "former.microsoft@rditrials.com",
      name: "Former Microsoft",
      provider: "microsoft-entra-id",
      activeAccountId: microsoft.accountId,
      expiresAt: past,
    }),
  );
  assert.ok(
    fetchCalls.slice(beforeMicrosoft).some((call) =>
      call.url.includes("/oauth2/v2.0/token"),
    ),
    "harness: an expired Microsoft access token must be sent to the token endpoint",
  );
  await expectCorpusRefused(microsoftSession.cookie, microsoft, "revoked Microsoft grant");

  const markedUser = await accounts.upsertUser("marked.employee@rditrials.com");
  const marked = await seedCorpus(pool, {
    userId: markedUser,
    provider: "google",
    email: "marked.employee@rditrials.com",
    marker: "marked-reconnect-marker",
    accessExpiresAt: future,
    status: "reconnect_required",
  });
  const beforeMarked = fetchCalls.length;
  const markedSession = await readSession(
    await sessionJwt({
      email: "marked.employee@rditrials.com",
      sub: "marked.employee@rditrials.com",
      name: "Marked",
      provider: "google",
      activeAccountId: marked.accountId,
      expiresAt: future,
    }),
  );
  assert.equal(
    fetchCalls.length,
    beforeMarked,
    "harness: a credential already marked reconnect_required must be refused without another token refresh",
  );
  await expectCorpusRefused(markedSession.cookie, marked, "credential status reconnect_required");

  const erroredUser = await accounts.upsertUser("errored.employee@rditrials.com");
  const errored = await seedCorpus(pool, {
    userId: erroredUser,
    provider: "google",
    email: "errored.employee@rditrials.com",
    marker: "session-error-marker",
    accessExpiresAt: future,
  });
  const erroredSession = await readSession(
    await sessionJwt({
      email: "errored.employee@rditrials.com",
      sub: "errored.employee@rditrials.com",
      name: "Errored",
      provider: "google",
      activeAccountId: errored.accountId,
      expiresAt: future,
      error: "RefreshAccessTokenError",
    }),
  );
  assert.equal(
    (await accounts.getOwnedAccount(erroredUser, errored.accountId as never))?.status,
    "active",
    "harness: this case keeps the stored credential active so the session error is the only signal",
  );
  await expectCorpusRefused(erroredSession.cookie, errored, "session error with active credentials");

  const owner = await accounts.upsertUser("owner.employee@rditrials.com");
  const primary = await seedCorpus(pool, {
    userId: owner,
    provider: "google",
    email: "owner.employee@rditrials.com",
    marker: "owner-primary-marker",
    accessExpiresAt: future,
  });
  const linked = await seedCorpus(pool, {
    userId: owner,
    provider: "microsoft",
    email: "linked.mailbox@rditrials.com",
    marker: "linked-revoked-marker",
    accessExpiresAt: future,
    status: "reconnect_required",
  });
  const linkedSession = await readSession(
    await sessionJwt({
      email: "owner.employee@rditrials.com",
      sub: "owner.employee@rditrials.com",
      name: "Owner",
      provider: "google",
      activeAccountId: primary.accountId,
      expiresAt: future,
    }),
    `${ACTIVE_ACCOUNT_COOKIE}=${linked.accountId}`,
  );
  const linkedMailbox = await call(
    linkedSession.cookie,
    new Request("http://localhost:3000/api/v3/mailbox?folder=inbox"),
    (request) => mailboxRoute.GET(request),
  );
  expectSecure(
    !linkedMailbox.body.includes(linked.subject),
    `linked revoked mailbox: GET /api/v3/mailbox returned ${linkedMailbox.status} and ${
      linkedMailbox.body.includes(linked.subject) ? "included" : "omitted"
    } the linked subject while the cookie selected that account`,
  );
  const linkedConversation = await call(
    linkedSession.cookie,
    new Request(`http://localhost:3000/api/v3/conversations/${linked.conversationId}`),
    (request) =>
      conversationRoute.GET(request, {
        params: Promise.resolve({ id: linked.conversationId }),
      }),
  );
  expectSecure(
    !linkedConversation.body.includes(linked.body),
    `linked revoked mailbox: GET /api/v3/conversations/[id] returned ${linkedConversation.status} and ${
      linkedConversation.body.includes(linked.body) ? "included" : "omitted"
    } the linked body`,
  );

  if (failures.length > 0) {
    console.error(failures.map((failure) => `- ${failure}`).join("\n"));
    process.exitCode = 1;
    throw new Error(`${failures.length} revoked-grant assertion(s) failed`);
  }
  console.log("revoked-grant-session: OK");
} finally {
  globalThis.fetch = realFetch;
  await db.stop();
  await rm(process.env.SEER_DATA_DIR, { recursive: true, force: true });
}
