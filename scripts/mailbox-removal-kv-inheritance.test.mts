/**
 * Removing a mailbox must not leave address-keyed documents for the next
 * owner of that address. These assertions fail while removal only deletes
 * the mail account row.
 *
 * Run: node --import tsx scripts/mailbox-removal-kv-inheritance.test.mts
 */
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "next/headers" || specifier === "next/headers.js") {
      return {
        url: pathToFileURL(path.join(ROOT, "scripts/shims/next-headers.mjs")).href,
        shortCircuit: true,
      };
    }
    if (specifier === "@/auth") {
      return {
        url: pathToFileURL(path.join(ROOT, "scripts/shims/auth-session.mjs")).href,
        shortCircuit: true,
      };
    }
    return nextResolve(specifier, context);
  },
});

const PREVIOUS_OWNER = "previous.owner@rditrials.com";
const NEXT_OWNER = "next.owner@rditrials.com";
const MAILBOX = "shared.trials@rditrials.com";
const PROFILE_MARKER = "previous-owner-profile-marker";
const EA_EMAIL = "previous-ea@example.com";
const TEXTING_FRIEND = "previous-texting-friend@example.com";
const VIP_EMAIL = "previous-vip@example.com";
const ADDRESS_BOOK = "previous-address-book@example.com";
const KEPT_SENDER = "previous-kept@example.com";
const BRIEF_MARKER = "previous-owner-brief-marker";
const LEDGER_MARKER = "previous-owner-ledger-marker";
const DECISION_ID = "previous-owner-decision";
const WAITING_SUBJECT = "previous-owner-waiting-marker";
const WAITING_PEER = "previous-waiting@example.com";
const FUNCTION_MARKER = "previous-owner-function";
const EXEMPLAR_MARKER = "previous-owner-exemplar";
const MERCHANT_EMAIL = "previous-biller@example.com";
const UNDERSTANDING_MARKER = "previous-owner-understanding";
const AUTONOMY_REASON = "previous-owner-reason";
const SENDER_MEMORY = "previous-sender@example.com";
const REPLIED_THREAD = "previous-owner-thread";
const MATTER_ID = "previous-owner-matter";
const MATTER_TITLE = "previous-owner-matter-title";
const CLOSED_REASON = "previous-owner-closed";
const ORG_UNIT = "previous-owner-org";
const SNAPSHOT_SUBJECT = "previous-owner-snapshot";
const SF_USERNAME = "previous-owner@example.com";
const OPPORTUNITY_NAME = "RCD_2818 previous-owner pipeline";
const LABEL_ID = "Label_previous_owner";

const PLACEHOLDER_MAIL_ACCESS_PREVIOUS = "PLACEHOLDER_MAIL_ACCESS_PREVIOUS";
const PLACEHOLDER_MAIL_REFRESH_PREVIOUS = "PLACEHOLDER_MAIL_REFRESH_PREVIOUS";
const PLACEHOLDER_MAIL_ACCESS_NEXT = "PLACEHOLDER_MAIL_ACCESS_NEXT";
const PLACEHOLDER_MAIL_REFRESH_NEXT = "PLACEHOLDER_MAIL_REFRESH_NEXT";
const PLACEHOLDER_SF_CLIENT_ID = "PLACEHOLDER_SF_CLIENT_ID";
const PLACEHOLDER_SF_CLIENT_SECRET = "PLACEHOLDER_SF_CLIENT_SECRET";
const PLACEHOLDER_SF_REFRESH = "PLACEHOLDER_SF_REFRESH";
const PLACEHOLDER_SF_ACCESS = "PLACEHOLDER_SF_ACCESS";
const PLACEHOLDER_BB_PASSWORD = "PLACEHOLDER_BB_PASSWORD";
const PLACEHOLDER_OAUTH_CODE = "PLACEHOLDER_OAUTH_CODE";
const PLACEHOLDER_SF_STATE = "PLACEHOLDER_SF_STATE";
const PLACEHOLDER_SF_VERIFIER = "PLACEHOLDER_SF_VERIFIER";
const BB_URL = "http://bluebubbles.invalid";
const SF_INSTANCE = "https://inherited.example.invalid";
const APP_ORIGIN = "http://127.0.0.1:3000";

type FetchCall = { url: string; method: string; body: string; authorization: string };

const fetchLog: FetchCall[] = [];
let refreshPresentations = 0;
let blueBubblesPasswords = 0;

function headerValue(init: RequestInit | undefined, name: string): string {
  const headers = init?.headers;
  if (!headers) return "";
  if (headers instanceof Headers) return headers.get(name) ?? "";
  if (Array.isArray(headers)) {
    const found = headers.find(([key]) => key.toLowerCase() === name.toLowerCase());
    return found?.[1] ?? "";
  }
  const key = Object.keys(headers).find((item) => item.toLowerCase() === name.toLowerCase());
  return key ? String(headers[key]) : "";
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function waitingMessage() {
  const sentAt = Date.now() - 10 * 24 * 60 * 60 * 1000;
  return {
    id: "m-waiting",
    threadId: "t-waiting",
    snippet: WAITING_SUBJECT,
    internalDate: String(sentAt),
    labelIds: [],
    payload: {
      headers: [
        { name: "From", value: `Previous Owner <${MAILBOX}>` },
        { name: "To", value: `Pat <${WAITING_PEER}>` },
        { name: "Subject", value: WAITING_SUBJECT },
      ],
    },
  };
}

function installFetchStandIn() {
  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url;
    const method = (
      init?.method ??
      (typeof input === "object" && !(input instanceof URL) ? input.method : "GET")
    ).toUpperCase();
    const body =
      typeof init?.body === "string"
        ? init.body
        : init?.body
          ? String(init.body)
          : "";
    const authorization = headerValue(init, "authorization");
    fetchLog.push({ url, method, body, authorization });
    const previousMail = authorization.includes(PLACEHOLDER_MAIL_ACCESS_PREVIOUS);

    if (url.startsWith("https://oauth2.googleapis.com/revoke")) {
      return new Response("", { status: 200 });
    }

    if (url.startsWith(`${BB_URL}/`)) {
      const password = new URL(url).searchParams.get("password") ?? "";
      if (password !== PLACEHOLDER_BB_PASSWORD) {
        return jsonResponse({ message: "denied" }, 401);
      }
      blueBubblesPasswords += 1;
      if (url.includes("/api/v1/server/info")) {
        return jsonResponse({ data: { server_version: "test", os_version: "test" } });
      }
      if (url.includes("/api/v1/contact")) {
        return jsonResponse({
          data: [
            {
              displayName: "Previous Texting Friend",
              emails: [{ address: TEXTING_FRIEND }],
            },
          ],
        });
      }
      if (url.includes("/api/v1/chat/query")) {
        return jsonResponse({
          data: [
            {
              guid: "chat-previous",
              participants: [{ address: TEXTING_FRIEND }],
              lastMessage: { dateCreated: Date.now() },
            },
          ],
        });
      }
    }

    if (url.includes("/services/oauth2/token") && method === "POST") {
      const params = new URLSearchParams(body);
      if (params.get("grant_type") === "refresh_token") {
        if (
          params.get("refresh_token") !== PLACEHOLDER_SF_REFRESH ||
          params.get("client_id") !== PLACEHOLDER_SF_CLIENT_ID ||
          params.get("client_secret") !== PLACEHOLDER_SF_CLIENT_SECRET
        ) {
          return jsonResponse({ error: "invalid_grant" }, 400);
        }
        refreshPresentations += 1;
        return jsonResponse({
          access_token: PLACEHOLDER_SF_ACCESS,
          instance_url: SF_INSTANCE,
        });
      }
      if (params.get("grant_type") === "authorization_code") {
        return jsonResponse({
          access_token: PLACEHOLDER_SF_ACCESS,
          refresh_token: PLACEHOLDER_SF_REFRESH,
          instance_url: SF_INSTANCE,
          id: "https://login.salesforce.com/id/previous-org/previous-user",
        });
      }
      return jsonResponse({ error: "unsupported_grant" }, 400);
    }

    if (url.startsWith("https://login.salesforce.com/id/")) {
      return jsonResponse({
        username: SF_USERNAME,
        display_name: "Previous Owner",
        organization_id: "previous-org",
      });
    }

    if (url.startsWith(`${SF_INSTANCE}/services/data/v61.0/query`)) {
      const query = new URL(url).searchParams.get("q") ?? "";
      if (query.includes("FROM Opportunity")) {
        return jsonResponse({
          records: [
            {
              Name: OPPORTUNITY_NAME,
              StageName: "Open",
              Amount: 2818,
              Account: { Name: "Previous Account" },
              Owner: { Name: "Previous Owner" },
            },
          ],
        });
      }
      return jsonResponse({ records: [] });
    }

    if (url.startsWith(`${SF_INSTANCE}/services/data/v61.0/sobjects`)) {
      return jsonResponse({ sobjects: [] });
    }

    if (url.startsWith("https://people.googleapis.com/v1/people/me/connections")) {
      return jsonResponse(
        previousMail
          ? {
              connections: [{ emailAddresses: [{ value: ADDRESS_BOOK }] }],
            }
          : { connections: [] },
      );
    }
    if (url.startsWith("https://people.googleapis.com/v1/otherContacts")) {
      return jsonResponse({ otherContacts: [] });
    }
    if (url.startsWith("https://www.googleapis.com/calendar/")) {
      return jsonResponse({ items: [] });
    }

    if (url.startsWith("https://gmail.googleapis.com/gmail/v1/users/me/messages?")) {
      const query = new URL(url).searchParams.get("q") ?? "";
      if (previousMail && query.includes("in:sent")) {
        return jsonResponse({ messages: [{ id: "m-waiting", threadId: "t-waiting" }] });
      }
      return jsonResponse({ messages: [] });
    }
    if (url.includes("/users/me/messages/m-waiting")) {
      return jsonResponse(waitingMessage());
    }
    if (url.includes("/users/me/threads/t-waiting")) {
      return jsonResponse({ messages: [waitingMessage()] });
    }
    if (url.endsWith("/users/me/labels") || url.includes("/users/me/labels?")) {
      return jsonResponse(
        previousMail
          ? { labels: [{ id: LABEL_ID, name: "Seer/act_today" }] }
          : { labels: [] },
      );
    }
    if (url.includes("/users/me/messages/batchModify") || url.includes("/users/me/labels")) {
      return jsonResponse({});
    }

    throw new Error(`unhandled fetch ${method} ${url}`);
  };
}

function asSignedIn(email: string, accountId: string) {
  globalThis.__seerMailboxTestAuth = {
    user: { email },
    provider: "google",
    activeAccountId: accountId,
    error: undefined,
  };
}

async function readJson(res: Response): Promise<Record<string, unknown>> {
  return (await res.json()) as Record<string, unknown>;
}

const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "seer-mailbox-kv-"));
process.env.NODE_ENV = "test";
process.env.SEER_DATA_DIR = dataDir;
delete process.env.SEER_V2_DATABASE_URL;
delete process.env.POSTGRES_URL;
delete process.env.POSTGRES_PRISMA_URL;
delete process.env.DATABASE_URL;
delete process.env.UPSTASH_REDIS_REST_URL;
delete process.env.UPSTASH_REDIS_REST_TOKEN;
delete process.env.KV_REST_API_URL;
delete process.env.KV_REST_API_TOKEN;
delete process.env.SEER_USER_PROFILE;
delete process.env.SEER_USER_PROFILE_UPDATED_AT;
delete process.env.SEER_EA_EMAIL;
delete process.env.SEER_EA_NAME;
delete process.env.SALESFORCE_CLIENT_ID;
delete process.env.SALESFORCE_CLIENT_SECRET;
delete process.env.SALESFORCE_LOGIN_URL;
delete process.env.SALESFORCE_USERNAME;
delete process.env.SALESFORCE_PRIVATE_KEY;
delete process.env.SALESFORCE_REFRESH_TOKEN;
delete process.env.SF_CLIENT_ID;
delete process.env.SF_CLIENT_SECRET;
delete process.env.SF_LOGIN_URL;
delete process.env.SF_USERNAME;
delete process.env.SF_PRIVATE_KEY;
delete process.env.SF_REFRESH_TOKEN;
delete process.env.SEER_CREDENTIAL_KEY;

installFetchStandIn();

const { startTestDb } = await import("./v2-testdb.mts");
const accounts = await import("../src/lib/v2/db/accounts.ts");
const { setActiveAccountId } = await import("../src/lib/store/accounts.ts");
const { requireMailSession } = await import("../src/lib/mail/session.ts");
const accountRoutes = await import("../src/app/api/v3/accounts/route.ts");
const profileRoutes = await import("../src/app/api/profile/route.ts");
const eaRoutes = await import("../src/app/api/ea/route.ts");
const salesforceRoutes = await import("../src/app/api/salesforce/route.ts");
const salesforceCallback = await import("../src/app/api/salesforce/callback/route.ts");
const imessageRoutes = await import("../src/app/api/imessage/route.ts");
const contactsRoutes = await import("../src/app/api/contacts/route.ts");
const vipsRoutes = await import("../src/app/api/vips/route.ts");
const briefRoutes = await import("../src/app/api/brief/route.ts");
const ledgerRoutes = await import("../src/app/api/triage/ledger/route.ts");
const waitingRoutes = await import("../src/app/api/waiting/route.ts");
const correctRoutes = await import("../src/app/api/correct/route.ts");
const { loadSalesforce } = await import("../src/lib/store/salesforce.ts");
const { PROMPT_VERSION } = await import("../src/lib/inbox/gemini-triage.ts");
const { loadDecisions } = await import("../src/lib/store/decision-cache.ts");
const { saveBrief } = await import("../src/lib/inbox/matters.ts");
const { appendLedger } = await import("../src/lib/store/triage-ledger.ts");
const { saveFunctions, loadFunctions } = await import("../src/lib/store/functions.ts");
const { saveExemplars, loadExemplars } = await import("../src/lib/store/exemplars.ts");
const { saveMerchants, loadMerchants } = await import("../src/lib/store/merchants.ts");
const { saveUnderstanding, loadUnderstanding } = await import("../src/lib/store/understanding-store.ts");
const { recordAccepted, loadAutonomy } = await import("../src/lib/store/autonomy.ts");
const { recordSenderAction, loadActionMemory } = await import("../src/lib/store/action-memory.ts");
const { recordRepliedThread, loadRepliedThreads } = await import("../src/lib/store/replied-threads.ts");
const { renameMatter, createMatter, loadMatterEdits } = await import("../src/lib/store/manual-matters.ts");
const { closeMatter, loadClosedMatters } = await import("../src/lib/store/closed-matters.ts");
const { saveMatterFix, loadMatterFixes } = await import("../src/lib/store/matter-fixes.ts");
const { saveMatterOrder, loadMatterOrder } = await import("../src/lib/store/matter-order.ts");
const { markOpened, readLastOpen } = await import("../src/lib/store/last-open.ts");
const { getInboxSnapshot } = await import("../src/lib/mail/inbox-snapshot.ts");
const { getOrBuildMailHistory, loadCachedHistory } = await import("../src/lib/inbox/mail-history-store.ts");
const { makeGmailLabelStore } = await import("../src/lib/mail/seer-labels.ts");
const { getPersonalContext } = await import("../src/lib/inbox/personal-context.ts");
const { cookies } = await import("next/headers");

const db = await startTestDb();

function post(pathname: string, body: unknown) {
  return new Request(`${APP_ORIGIN}${pathname}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: APP_ORIGIN,
    },
    body: JSON.stringify(body),
  });
}

function get(pathname: string) {
  return new Request(`${APP_ORIGIN}${pathname}`, { method: "GET" });
}

try {
  const previousUser = await accounts.upsertUser(PREVIOUS_OWNER);
  const nextUser = await accounts.upsertUser(NEXT_OWNER);
  const previousAccount = await accounts.upsertAccountWithCredentials({
    userId: previousUser,
    provider: "google",
    email: MAILBOX,
    displayName: "Shared trials",
    accessToken: PLACEHOLDER_MAIL_ACCESS_PREVIOUS,
    refreshToken: PLACEHOLDER_MAIL_REFRESH_PREVIOUS,
    expiresAt: Date.now() + 3_600_000,
  });

  await assert.rejects(
    () =>
      accounts.upsertAccountWithCredentials({
        userId: nextUser,
        provider: "google",
        email: MAILBOX,
        displayName: "Shared trials",
        accessToken: PLACEHOLDER_MAIL_ACCESS_NEXT,
        refreshToken: PLACEHOLDER_MAIL_REFRESH_NEXT,
        expiresAt: Date.now() + 3_600_000,
      }),
    /belongs to another user/,
    "a second owner cannot take the mailbox while the first account row exists",
  );

  asSignedIn(PREVIOUS_OWNER, previousAccount.id);
  await setActiveAccountId(previousAccount.id);
  const previousSession = await requireMailSession();
  assert.equal(previousSession?.email, MAILBOX);
  assert.ok(previousSession);

  const profileSave = await profileRoutes.POST(
    post("/api/profile", { text: PROFILE_MARKER }),
  );
  assert.equal(profileSave.status, 200, await profileSave.clone().text());

  const eaSave = await eaRoutes.POST(
    post("/api/ea", { email: EA_EMAIL, name: "Previous EA" }),
  );
  assert.equal(eaSave.status, 200, await eaSave.clone().text());

  const appSave = await salesforceRoutes.POST(
    post("/api/salesforce", {
      action: "app",
      clientId: PLACEHOLDER_SF_CLIENT_ID,
      clientSecret: PLACEHOLDER_SF_CLIENT_SECRET,
    }),
  );
  assert.equal(appSave.status, 200, await appSave.clone().text());

  const jar = await cookies();
  jar.set("sf_verifier", PLACEHOLDER_SF_VERIFIER);
  jar.set("sf_state", PLACEHOLDER_SF_STATE);
  jar.set("sf_return", "/");
  const callback = await salesforceCallback.GET(
    new Request(
      `${APP_ORIGIN}/api/salesforce/callback?code=${PLACEHOLDER_OAUTH_CODE}&state=${PLACEHOLDER_SF_STATE}`,
    ),
  );
  const callbackLocation = callback.headers.get("location") ?? "";
  assert.match(callbackLocation, /sf=connected/, callbackLocation);

  const previousSync = await salesforceRoutes.POST(
    post("/api/salesforce", { action: "sync" }),
  );
  assert.equal(previousSync.status, 200, await previousSync.clone().text());
  assert.equal(refreshPresentations, 1);
  const previousSalesforce = await readJson(await salesforceRoutes.GET());
  const previousConnection = previousSalesforce.connection as { username?: string } | null;
  assert.equal(previousConnection?.username, SF_USERNAME);
  const previousCounts = previousSalesforce.counts as { opportunities?: number };
  assert.equal(previousCounts.opportunities, 1);

  const imessageSave = await imessageRoutes.POST(
    post("/api/imessage", {
      action: "save",
      url: BB_URL,
      password: PLACEHOLDER_BB_PASSWORD,
    }),
  );
  assert.equal(imessageSave.status, 200, await imessageSave.clone().text());
  const imessageSync = await imessageRoutes.POST(
    post("/api/imessage", { action: "sync" }),
  );
  assert.equal(imessageSync.status, 200, await imessageSync.clone().text());
  assert.ok(blueBubblesPasswords >= 1);

  const vipSave = await vipsRoutes.POST(
    post("/api/vips", { email: VIP_EMAIL, name: "Previous VIP", vip: true }),
  );
  assert.equal(vipSave.status, 200, await vipSave.clone().text());

  const correction = await correctRoutes.POST(
    post("/api/correct", {
      id: DECISION_ID,
      action: "act_today",
      task: "previous-owner decision",
    }),
  );
  assert.equal(correction.status, 200, await correction.clone().text());

  await saveBrief(previousSession.email, {
    builtAt: new Date().toISOString(),
    summary: BRIEF_MARKER,
    matters: [],
    headlines: [],
    headlineIds: [],
  });
  await appendLedger(previousSession.email, {
    kind: "archive",
    summary: LEDGER_MARKER,
    source: "manual",
  });
  await saveFunctions(previousSession.email, [FUNCTION_MARKER]);
  await saveExemplars(previousSession.email, [
    { subject: EXEMPLAR_MARKER, category: "personal" },
  ]);
  await saveMerchants(previousSession.email, {
    [MERCHANT_EMAIL]: {
      key: MERCHANT_EMAIL,
      name: "Previous Biller",
      amounts: [42],
      count: 1,
      lastAt: new Date().toISOString(),
    },
  });
  await saveUnderstanding(previousSession.email, {
    "msg-previous": {
      id: "msg-previous",
      threadId: "thread-previous",
      version: 4,
      readAt: new Date().toISOString(),
      kind: "personal note",
      oneLine: UNDERSTANDING_MARKER,
      ask: "nothing — informational",
      owner: "you",
      entities: [],
      org: { unit: "personal", confidence: 1 },
      importance: 1,
      disposition: "fyi",
    },
  });
  await recordAccepted(previousSession.email, AUTONOMY_REASON);
  await recordSenderAction(previousSession.email, SENDER_MEMORY, "archive");
  await recordRepliedThread(previousSession.email, REPLIED_THREAD);
  await renameMatter(previousSession.email, MATTER_ID, MATTER_TITLE);
  await createMatter(previousSession.email, { title: MATTER_TITLE });
  await closeMatter(previousSession.email, {
    matterId: MATTER_ID,
    titleTokens: ["previous", "owner"],
    threadIds: [REPLIED_THREAD],
    reason: CLOSED_REASON,
    by: "user",
  });
  await saveMatterFix(previousSession.email, MATTER_ID, ORG_UNIT);
  await saveMatterOrder(previousSession.email, ORG_UNIT, [MATTER_ID]);
  await markOpened(previousSession.email);
  await getInboxSnapshot(previousSession.email, async () => [
    {
      id: "snap-1",
      threadId: "snap-thread",
      fromEmail: KEPT_SENDER,
      fromName: "Kept",
      subject: SNAPSHOT_SUBJECT,
      snippet: SNAPSHOT_SUBJECT,
      receivedAt: new Date().toISOString(),
      isUnread: false,
    },
  ]);
  await getOrBuildMailHistory(
    previousSession.email,
    previousSession.accessToken,
    {
      listFolder: async () => [],
      listArchive: async () => [
        {
          id: "kept-1",
          threadId: "kept-thread",
          fromEmail: KEPT_SENDER,
          fromName: "Kept",
          subject: "kept",
          snippet: "kept",
          receivedAt: new Date().toISOString(),
          isUnread: false,
        },
      ],
    },
  );

  const previousContacts = await readJson(await contactsRoutes.GET(get("/api/contacts")));
  const previousSuggestions = previousContacts.contacts as { email: string }[];
  assert.ok(
    previousSuggestions.some((item) => item.email === TEXTING_FRIEND),
    JSON.stringify(previousContacts),
  );
  assert.ok(
    previousSuggestions.some((item) => item.email === ADDRESS_BOOK),
    JSON.stringify(previousContacts),
  );

  const previousWaiting = await readJson(await waitingRoutes.GET(get("/api/waiting")));
  const previousWaitingItems = previousWaiting.items as { subject?: string }[];
  assert.ok(previousWaitingItems.some((item) => item.subject === WAITING_SUBJECT));

  const previousBrief = await readJson(await briefRoutes.GET());
  assert.equal((previousBrief.brief as { summary?: string }).summary, BRIEF_MARKER);

  const removed = await accountRoutes.POST(
    post("/api/v3/accounts", {
      action: "remove",
      id: previousAccount.id,
      confirmed: true,
    }),
  );
  assert.equal(removed.status, 200, await removed.clone().text());
  assert.equal(await accounts.getOwnedAccount(previousUser, previousAccount.id), null);

  const nextAccount = await accounts.upsertAccountWithCredentials({
    userId: nextUser,
    provider: "google",
    email: MAILBOX,
    displayName: "Shared trials",
    accessToken: PLACEHOLDER_MAIL_ACCESS_NEXT,
    refreshToken: PLACEHOLDER_MAIL_REFRESH_NEXT,
    expiresAt: Date.now() + 3_600_000,
  });
  assert.notEqual(nextAccount.id, previousAccount.id);
  assert.equal(nextAccount.userId, nextUser);

  asSignedIn(NEXT_OWNER, nextAccount.id);
  await setActiveAccountId(nextAccount.id);
  const nextSession = await requireMailSession();
  assert.equal(nextSession?.email, MAILBOX);
  assert.equal(nextSession?.accountId, nextAccount.id);
  assert.ok(nextSession);

  const leaks: string[] = [];
  const expectSecure = (name: string, fn: () => void) => {
    try {
      fn();
    } catch (error) {
      leaks.push(`${name}: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  const inheritedProfile = await readJson(await profileRoutes.GET());
  expectSecure("profile", () => assert.equal(inheritedProfile.profile, null));

  const inheritedEa = await readJson(await eaRoutes.GET());
  expectSecure("ea", () => assert.equal(inheritedEa.ea, null));

  const inheritedSalesforce = await readJson(await salesforceRoutes.GET());
  expectSecure("salesforce connection", () =>
    assert.equal(inheritedSalesforce.connection, null),
  );
  const inheritedCounts = inheritedSalesforce.counts as {
    opportunities?: number;
    studies?: number;
  };
  expectSecure("salesforce opportunities", () =>
    assert.equal(inheritedCounts.opportunities, 0),
  );
  expectSecure("salesforce studies", () => assert.equal(inheritedCounts.studies, 0));
  const registry = await loadSalesforce(nextSession.email);
  expectSecure("salesforce registry", () => {
    assert.equal(registry.opportunities.length, 0);
    assert.equal(
      registry.opportunities.some(
        (item) => item.name === OPPORTUNITY_NAME || item.code?.includes("RCD_2818"),
      ),
      false,
    );
  });

  const presentationsBefore = refreshPresentations;
  const passwordsBefore = blueBubblesPasswords;
  const inheritedSync = await salesforceRoutes.POST(
    post("/api/salesforce", { action: "sync" }),
  );
  expectSecure("salesforce sync status", () => assert.equal(inheritedSync.status, 400));
  expectSecure("salesforce refresh token", () =>
    assert.equal(refreshPresentations, presentationsBefore),
  );

  const inheritedImessage = await readJson(await imessageRoutes.GET());
  expectSecure("imessage config", () => {
    assert.equal(inheritedImessage.configured, false);
    assert.equal(inheritedImessage.url, null);
  });
  const inheritedTexting = await imessageRoutes.POST(
    post("/api/imessage", { action: "sync" }),
  );
  expectSecure("imessage sync status", () => assert.notEqual(inheritedTexting.status, 200));
  expectSecure("imessage password", () =>
    assert.equal(blueBubblesPasswords, passwordsBefore),
  );

  const inheritedContacts = await readJson(
    await contactsRoutes.GET(get("/api/contacts?q=previous")),
  );
  const contactEmails = ((inheritedContacts.contacts as { email: string }[]) ?? []).map(
    (item) => item.email,
  );
  expectSecure("contacts", () => {
    assert.equal(contactEmails.includes(TEXTING_FRIEND), false);
    assert.equal(contactEmails.includes(VIP_EMAIL), false);
    assert.equal(contactEmails.includes(ADDRESS_BOOK), false);
    assert.equal(contactEmails.includes(KEPT_SENDER), false);
    assert.equal(contactEmails.includes(WAITING_PEER), false);
  });

  const inheritedVips = await readJson(await vipsRoutes.GET());
  const vipEmails = ((inheritedVips.vips as { email: string }[]) ?? []).map((item) => item.email);
  const vipSuggestions = ((inheritedVips.suggestions as { email: string }[]) ?? []).map(
    (item) => item.email,
  );
  expectSecure("vips", () => {
    assert.equal(vipEmails.includes(VIP_EMAIL), false);
    assert.equal(vipSuggestions.includes(WAITING_PEER), false);
    assert.equal(vipSuggestions.includes(KEPT_SENDER), false);
  });

  const inheritedBrief = await readJson(await briefRoutes.GET());
  expectSecure("brief", () => assert.equal(inheritedBrief.brief, null));

  const inheritedLedger = await readJson(await ledgerRoutes.GET());
  const ledgerEntries = (inheritedLedger.entries as { summary?: string }[]) ?? [];
  expectSecure("ledger", () =>
    assert.equal(
      ledgerEntries.some((entry) => entry.summary === LEDGER_MARKER),
      false,
    ),
  );

  const inheritedWaiting = await readJson(await waitingRoutes.GET(get("/api/waiting")));
  const waitingItems = (inheritedWaiting.items as { subject?: string }[]) ?? [];
  expectSecure("waiting", () =>
    assert.equal(
      waitingItems.some((item) => item.subject === WAITING_SUBJECT),
      false,
    ),
  );

  const decisions = await loadDecisions(nextSession.email, [DECISION_ID], PROMPT_VERSION);
  expectSecure("decisions", () => assert.equal(decisions.has(DECISION_ID), false));

  const functions = await loadFunctions(nextSession.email);
  expectSecure("functions", () => assert.equal(functions.includes(FUNCTION_MARKER), false));
  const exemplars = await loadExemplars(nextSession.email);
  expectSecure("exemplars", () =>
    assert.equal(
      exemplars.some((item) => item.subject === EXEMPLAR_MARKER),
      false,
    ),
  );
  const merchants = await loadMerchants(nextSession.email);
  expectSecure("merchants", () => assert.equal(Object.hasOwn(merchants, MERCHANT_EMAIL), false));
  const understanding = await loadUnderstanding(nextSession.email);
  expectSecure("understanding", () =>
    assert.equal(
      Object.values(understanding).some((item) => item.oneLine === UNDERSTANDING_MARKER),
      false,
    ),
  );
  const autonomy = await loadAutonomy(nextSession.email);
  expectSecure("autonomy", () =>
    assert.equal(Object.hasOwn(autonomy.reasons, AUTONOMY_REASON), false),
  );
  const memory = await loadActionMemory(nextSession.email);
  expectSecure("action memory", () =>
    assert.equal(Object.hasOwn(memory, SENDER_MEMORY), false),
  );
  const replied = await loadRepliedThreads(nextSession.email);
  expectSecure("replied threads", () =>
    assert.equal(Object.hasOwn(replied, REPLIED_THREAD), false),
  );
  const edits = await loadMatterEdits(nextSession.email);
  expectSecure("matter edits", () => {
    assert.equal(Object.hasOwn(edits.renames, MATTER_ID), false);
    assert.equal(edits.manual.some((item) => item.title === MATTER_TITLE), false);
  });
  const closed = await loadClosedMatters(nextSession.email);
  expectSecure("closed matters", () => assert.equal(Object.hasOwn(closed, MATTER_ID), false));
  const fixes = await loadMatterFixes(nextSession.email);
  expectSecure("matter fixes", () => assert.equal(Object.hasOwn(fixes, MATTER_ID), false));
  const order = await loadMatterOrder(nextSession.email);
  expectSecure("matter order", () => assert.equal(Object.hasOwn(order, ORG_UNIT), false));
  const lastOpen = await readLastOpen(nextSession.email);
  expectSecure("last open", () => assert.equal(lastOpen, null));

  const snapshot = await getInboxSnapshot(nextSession.email, async () => []);
  expectSecure("inbox snapshot", () =>
    assert.equal(
      snapshot.some((item) => item.subject === SNAPSHOT_SUBJECT),
      false,
    ),
  );

  const rebuiltHistory = await getOrBuildMailHistory(
    nextSession.email,
    nextSession.accessToken,
    { listFolder: async () => [], listArchive: async () => [] },
  );
  expectSecure("mail history", () =>
    assert.equal(Object.hasOwn(rebuiltHistory.contacts, KEPT_SENDER), false),
  );
  const cachedHistory = await loadCachedHistory(nextSession.email);
  expectSecure("cached mail history", () =>
    assert.equal(
      cachedHistory == null || !Object.hasOwn(cachedHistory.contacts, KEPT_SENDER),
      true,
    ),
  );

  const personal = await getPersonalContext({
    accountEmail: nextSession.email,
    accessToken: nextSession.accessToken,
    provider: nextSession.provider,
  });
  expectSecure("personal context", () =>
    assert.equal(personal.contacts.includes(ADDRESS_BOOK), false),
  );

  const labels = await makeGmailLabelStore(nextSession.accessToken, nextSession.email);
  const inheritedAction = labels?.lookup({ labelIds: [LABEL_ID] } as never);
  expectSecure("gmail labels", () => assert.notEqual(inheritedAction, "act_today"));

  if (leaks.length > 0) {
    throw new Error(`previous owner's mailbox records were inherited:\n${leaks.join("\n")}`);
  }
  console.log("mailbox removal does not leave the previous owner's address-keyed records");
} finally {
  await db.stop();
  await fs.rm(dataDir, { recursive: true, force: true });
}
