/**
 * SEER_USER_PROFILE is one deployment's personal notes. It may be returned
 * only for the mailbox it was written for:
 *
 * - When SEER_USER_PROFILE_EMAIL is set, that address is the only mailbox.
 * - When it is unset, the mailbox is OWNER_EMAIL (the address this
 *   deployment names in source).
 *
 * Every other account, including every other address on the organization
 * domain, gets null when it has no saved profile of its own. Clearing a
 * profile, or storing a blank one, must not bring the deployment text
 * back. Classification, the brief, drafts, VIP scoring, and the legacy
 * sync job must not be told that those notes describe the caller.
 *
 * These assertions fail while loadUserProfile substitutes the deployment
 * text for any account that has no row of its own.
 */
import "./profile-fallback-env.mts";
import assert from "node:assert/strict";
import { after, afterEach, before, describe, test } from "node:test";
import { encode } from "@auth/core/jwt";
import { AfterContext } from "next/dist/server/after/after-context.js";
import { workAsyncStorageInstance } from "next/dist/server/app-render/work-async-storage-instance.js";
import { workUnitAsyncStorageInstance } from "next/dist/server/app-render/work-unit-async-storage-instance.js";
import { createRequestStoreForAPI } from "next/dist/server/async-storage/request-store.js";
import { OWNER_EMAIL, isAllowedOrgEmail } from "../src/lib/auth/org.ts";
import { classifyMessage } from "../src/lib/inbox/classify.ts";
import { classifyInboxWithAssistant } from "../src/lib/inbox/gemini-triage.ts";
import { buildBrief } from "../src/lib/inbox/matters.ts";
import type { EmailItem } from "../src/lib/inbox/types.ts";
import { upsertAccountWithCredentials, upsertUser } from "../src/lib/v2/db/accounts.ts";
import { kvDelete, kvSet } from "../src/lib/store/kv.ts";
import {
  clearUserProfile,
  loadUserProfile,
  saveUserProfile,
} from "../src/lib/store/user-profile.ts";
import { startTestDb, type TestDb } from "./v2-testdb.mts";

const MARKER = "SEER_PROFILE_MARKER_zqxvipmarker";
const COLLEAGUE = "second.desk@rditrials.com";
const OUTSIDE = "outside.desk@example.com";
const NAMED = "desk.profile@rditrials.com";
const ACCESS_TOKEN = "placeholder-access-token";
const SESSION_SALT = "authjs.session-token";

const originalFetch = globalThis.fetch;
const modelBodies: string[] = [];
let activeMessageId = "msg-1";

type RouteHandler = (request?: Request) => Promise<Response>;

let profileGet: RouteHandler;
let profilePost: RouteHandler;
let mailboxGet: RouteHandler;
let todayGet: RouteHandler;
let allTasksGet: RouteHandler;
let briefPost: RouteHandler;
let draftPost: RouteHandler;
let vipsGet: RouteHandler;
let cronGet: RouteHandler;
let db: TestDb;

function deploymentProfile(email?: string) {
  process.env.SEER_USER_PROFILE = `${MARKER} family companies priorities`;
  if (email) process.env.SEER_USER_PROFILE_EMAIL = email;
  else delete process.env.SEER_USER_PROFILE_EMAIL;
}

function clearDeploymentProfile() {
  delete process.env.SEER_USER_PROFILE;
  delete process.env.SEER_USER_PROFILE_EMAIL;
  delete process.env.SEER_USER_PROFILE_UPDATED_AT;
  delete process.env.SEER_ALLOWED_EMAILS;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(status === 204 ? null : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function gmailMessage(id: string) {
  const text = Buffer.from("Can we talk about the visit tomorrow?").toString(
    "base64",
  );
  return {
    id,
    threadId: `thread-${id}`,
    snippet: "Can we talk about the visit tomorrow?",
    internalDate: String(Date.now()),
    labelIds: ["INBOX"],
    payload: {
      mimeType: "text/plain",
      headers: [
        { name: "From", value: "Pat Sender <pat.sender@example.com>" },
        { name: "To", value: `Colleague <${COLLEAGUE}>` },
        { name: "Subject", value: "Question about the site visit" },
      ],
      body: { data: text, size: text.length },
    },
  };
}

function modelResponse(system: string, messageId: string): unknown {
  if (system.includes("chief of staff") || system.includes("MATTERS")) {
    return {
      summary: "One visit question is waiting.",
      matters: [
        {
          id: "site-visit",
          title: "Site visit",
          goal: "The visit is on the calendar",
          category: "work",
          orgUnit: "General",
          orgConfidence: 0.4,
          people: [],
          narrative: "Someone asked about a visit.",
          nextAction: "Reply",
          owner: "you",
          urgency: 1,
          status: "active",
          emailIds: [messageId],
        },
      ],
    };
  }
  if (system.includes("draft email replies") || system.includes("Write ONLY the reply")) {
    return { body: "Thanks, I will reply tomorrow." };
  }
  if (system.includes("disposition")) {
    return {
      emails: [
        {
          id: messageId,
          kind: "person",
          oneLine: "A question about a visit",
          ask: "Reply about the visit",
          owner: "you",
          importance: 2,
          disposition: "matter",
          org: { unit: "General", confidence: 0.4 },
          entities: [],
        },
      ],
    };
  }
  return {
    items: [
      {
        id: messageId,
        action: "respond",
        confidence: 0.8,
        reason: "A person asked a question",
        instruction: "Reply",
        task: "none",
        sender: "person",
        credible: true,
        importance: 2,
        deed: "none",
      },
    ],
  };
}

function installFetch() {
  modelBodies.length = 0;
  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const method = init?.method ?? (typeof input === "object" && "method" in input ? input.method : "GET");
    if (url.includes(":generateContent")) {
      const raw = await bodyText(init?.body ?? (typeof input !== "string" && !(input instanceof URL) ? input.body : undefined));
      modelBodies.push(raw);
      let system = "";
      try {
        const parsed = JSON.parse(raw) as {
          systemInstruction?: { parts?: { text?: string }[] };
        };
        system = (parsed.systemInstruction?.parts ?? [])
          .map((part) => part.text ?? "")
          .join("\n");
      } catch {
        system = raw;
      }
      const idMatch = raw.match(/"id":"([^"]+)"/);
      return jsonResponse({
        candidates: [
          {
            content: {
              role: "model",
              parts: [
                {
                  text: JSON.stringify(
                    modelResponse(system, idMatch?.[1] ?? activeMessageId),
                  ),
                },
              ],
            },
            finishReason: "STOP",
          },
        ],
        usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 },
      });
    }
    if (url.includes("gmail.googleapis.com")) {
      const path = new URL(url).pathname;
      if (path.endsWith("/messages") && method !== "POST") {
        const q = new URL(url).searchParams.get("q") ?? "";
        if (q.includes("in:inbox") || q === "") {
          return jsonResponse({
            messages: [{ id: activeMessageId, threadId: `thread-${activeMessageId}` }],
          });
        }
        return jsonResponse({ messages: [] });
      }
      if (path.includes("/messages/") && path.endsWith(activeMessageId)) {
        return jsonResponse(gmailMessage(activeMessageId));
      }
      if (path.includes("/threads/")) {
        const message = gmailMessage(activeMessageId);
        return jsonResponse({
          messages: [
            {
              id: message.id,
              internalDate: message.internalDate,
              labelIds: message.labelIds,
              payload: { headers: message.payload.headers },
            },
          ],
        });
      }
      if (path.endsWith("/labels/INBOX")) {
        return jsonResponse({ messagesTotal: 1, threadsTotal: 1 });
      }
      if (path.endsWith("/labels") && method === "POST") {
        return jsonResponse({ id: "Label_test" });
      }
      if (path.endsWith("/labels")) {
        return jsonResponse({ labels: [] });
      }
      if (path.endsWith("/batchModify")) {
        return jsonResponse(null, 204);
      }
      return jsonResponse({});
    }
    if (url.includes("people.googleapis.com")) {
      if (url.includes("otherContacts")) return jsonResponse({ otherContacts: [] });
      return jsonResponse({ connections: [] });
    }
    if (url.includes("www.googleapis.com/calendar/")) {
      return jsonResponse({ items: [] });
    }
    throw new Error(`profile fallback test refused an outbound request to ${new URL(url).host}`);
  };
}

async function bodyText(body: BodyInit | null | undefined): Promise<string> {
  if (!body) return "";
  if (typeof body === "string") return body;
  if (body instanceof Uint8Array) return Buffer.from(body).toString("utf8");
  if (body instanceof ArrayBuffer) return Buffer.from(body).toString("utf8");
  return await new Response(body).text();
}

function restoreFetch() {
  globalThis.fetch = originalFetch;
}

async function sessionCookie(email: string): Promise<string> {
  const userId = await upsertUser(email);
  await upsertAccountWithCredentials({
    userId,
    provider: "google",
    email,
    displayName: email,
    accessToken: ACCESS_TOKEN,
    expiresAt: Date.now() + 60 * 60 * 1000,
  });
  const token = await encode({
    token: {
      email,
      name: email,
      sub: email,
      provider: "google",
    },
    secret: process.env.AUTH_SECRET!,
    salt: SESSION_SALT,
  });
  return `${SESSION_SALT}=${token}`;
}

async function withRequest<T>(cookie: string, run: () => Promise<T>): Promise<T> {
  const headers = {
    cookie,
    host: "localhost:3000",
    "x-forwarded-proto": "http",
    "x-forwarded-host": "localhost:3000",
  };
  const url = new URL("http://localhost:3000/api/profile");
  const pending: Promise<unknown>[] = [];
  let close = () => {};
  const afterContext = new AfterContext({
    waitUntil(promise: Promise<unknown>) {
      pending.push(promise);
    },
    onClose(resolve: () => void) {
      close = resolve;
    },
    onTaskError(error: unknown) {
      console.error(error);
    },
  });
  const requestStore = createRequestStoreForAPI({ headers }, url, [], () => {}, {
    previewModeId: "test",
    previewModeEncryptionKey: "test-preview-encryption-key",
    previewModeSigningKey: "test-preview-signing-key",
  });
  const workStore = {
    isStaticGeneration: false,
    page: "/api/profile/route",
    route: "/api/profile",
    forceStatic: false,
    afterContext,
  };
  try {
    return await workAsyncStorageInstance.run(workStore, () =>
      workUnitAsyncStorageInstance.run(requestStore, run),
    );
  } finally {
    close();
    await Promise.all(pending);
  }
}

async function forgetMailbox(email: string) {
  await clearUserProfile(email);
  for (const key of [
    `inbox-snap:${email}`,
    `decisions:${email}`,
    `mail-history:${email}`,
    `kept-scan:${email}`,
    `gmail-labels:${email}`,
    `brief:${email}`,
    `labels-era:${email}`,
  ]) {
    await kvDelete(key);
  }
}

function emailItem(id: string): EmailItem {
  return {
    id,
    threadId: `thread-${id}`,
    fromEmail: "pat.sender@example.com",
    fromName: "Pat Sender",
    subject: "Question about the site visit",
    snippet: "Can we talk about the visit tomorrow?",
    receivedAt: new Date().toISOString(),
    isUnread: true,
    labelIds: ["INBOX"],
  };
}

before(async () => {
  db = await startTestDb();
  profileGet = (await import("../src/app/api/profile/route.ts")).GET;
  profilePost = (await import("../src/app/api/profile/route.ts")).POST;
  mailboxGet = (await import("../src/app/api/mailbox/route.ts")).GET;
  todayGet = (await import("../src/app/api/today/route.ts")).GET;
  allTasksGet = (await import("../src/app/api/alltasks/route.ts")).GET;
  briefPost = (await import("../src/app/api/brief/route.ts")).POST;
  draftPost = (await import("../src/app/api/assist/draft/route.ts")).POST;
  vipsGet = (await import("../src/app/api/vips/route.ts")).GET;
  cronGet = (await import("../src/app/api/cron/sync/route.ts")).GET;
});

after(async () => {
  restoreFetch();
  clearDeploymentProfile();
  await db?.stop();
});

describe("deployment profile is not shared across mailboxes", { concurrency: 1 }, () => {
  afterEach(async () => {
    clearDeploymentProfile();
    delete process.env.SEER_LEGACY_CRON;
    delete process.env.SEER_V3_LEGACY_ACCOUNT_FALLBACK;
    delete process.env.CRON_SECRET;
    restoreFetch();
    await clearUserProfile(COLLEAGUE);
    await clearUserProfile(OWNER_EMAIL);
    await clearUserProfile(NAMED);
    await clearUserProfile(OUTSIDE);
  });

  test("an organization address with no saved profile is allowed to sign in", () => {
    assert.equal(isAllowedOrgEmail(COLLEAGUE), true);
    assert.equal(isAllowedOrgEmail(OWNER_EMAIL), true);
  });

  test("the owner's mailbox still receives the deployment profile", async () => {
    deploymentProfile();
    const profile = await loadUserProfile(OWNER_EMAIL);
    assert.equal(profile?.text.includes(MARKER), true);
  });

  test("another organization mailbox does not receive the deployment profile", async () => {
    deploymentProfile();
    const profile = await loadUserProfile(COLLEAGUE);
    assert.equal(profile, null);
  });

  test("an explicitly named mailbox is the only recipient", async () => {
    deploymentProfile(NAMED);
    assert.equal((await loadUserProfile(NAMED))?.text.includes(MARKER), true);
    assert.equal(await loadUserProfile(OWNER_EMAIL), null);
    assert.equal(await loadUserProfile(COLLEAGUE), null);
    assert.equal(
      (await loadUserProfile(NAMED.toUpperCase()))?.text.includes(MARKER),
      true,
    );
  });

  test("an extra allowed address does not receive the deployment profile", async () => {
    deploymentProfile();
    process.env.SEER_ALLOWED_EMAILS = OUTSIDE;
    assert.equal(isAllowedOrgEmail(OUTSIDE), true);
    assert.equal(await loadUserProfile(OUTSIDE), null);
  });

  test("a saved profile stays that account's own text", async () => {
    deploymentProfile();
    const saved = await saveUserProfile(COLLEAGUE, {
      text: "colleague own notes",
      source: "paste",
    });
    const loaded = await loadUserProfile(COLLEAGUE);
    assert.equal(loaded?.text, saved.text);
    assert.equal(loaded?.text.includes(MARKER), false);
  });

  test("clearing a profile does not restore the deployment text", async () => {
    deploymentProfile();
    await saveUserProfile(COLLEAGUE, {
      text: "temporary notes",
      source: "paste",
    });
    await clearUserProfile(COLLEAGUE);
    assert.equal(await loadUserProfile(COLLEAGUE), null);
    assert.equal((await loadUserProfile(OWNER_EMAIL))?.text.includes(MARKER), true);
  });

  test("a blank stored profile does not fall through to the deployment text", async () => {
    deploymentProfile();
    await kvSet(`profile:${COLLEAGUE}`, {
      text: "   ",
      updatedAt: new Date().toISOString(),
      source: "paste",
    });
    assert.equal(await loadUserProfile(COLLEAGUE), null);
  });

  test("GET /api/profile returns the deployment text only for its mailbox", async () => {
    deploymentProfile();
    const colleague = await sessionCookie(COLLEAGUE);
    const owner = await sessionCookie(OWNER_EMAIL);
    const other = await withRequest(colleague, () => profileGet());
    const own = await withRequest(owner, () => profileGet());
    assert.equal(other.status, 200);
    assert.equal(own.status, 200);
    const otherBody = (await other.json()) as { profile: { text?: string } | null };
    const ownBody = (await own.json()) as { profile: { text?: string } | null };
    assert.equal(otherBody.profile, null);
    assert.equal(ownBody.profile?.text.includes(MARKER), true);
  });

  test("clearing through the profile API does not reveal the deployment text", async () => {
    deploymentProfile();
    const colleague = await sessionCookie(COLLEAGUE);
    await saveUserProfile(COLLEAGUE, { text: "temporary notes", source: "paste" });
    const cleared = await withRequest(colleague, () =>
      profilePost(
        new Request("http://localhost:3000/api/profile", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ clear: true }),
        }),
      ),
    );
    assert.equal(cleared.status, 200);
    const again = await withRequest(colleague, () => profileGet());
    const body = (await again.json()) as { profile: { text?: string } | null };
    assert.equal(body.profile, null);
  });

  test("inbox classification is not told another mailbox's deployment notes", async () => {
    deploymentProfile();
    installFetch();
    const id = "classify-colleague";
    activeMessageId = id;
    await clearUserProfile(COLLEAGUE);
    const profile = await loadUserProfile(COLLEAGUE);
    await classifyInboxWithAssistant(
      COLLEAGUE,
      [
        {
          id,
          fromEmail: "pat.sender@example.com",
          fromName: "Pat Sender",
          subject: "Question about the site visit",
          snippet: "Can we talk about the visit tomorrow?",
          threadId: `thread-${id}`,
          receivedAt: new Date().toISOString(),
        },
      ],
      null,
      async () => null,
      classifyMessage,
      { profile, geminiEnabled: true },
    );
    assert.equal(modelBodies.length > 0, true);
    assert.equal(modelBodies.some((body) => body.includes(MARKER)), false);

    modelBodies.length = 0;
    const ownerProfile = await loadUserProfile(OWNER_EMAIL);
    await classifyInboxWithAssistant(
      OWNER_EMAIL,
      [
        {
          id: "classify-owner",
          fromEmail: "pat.sender@example.com",
          fromName: "Pat Sender",
          subject: "Question about the site visit",
          snippet: "Can we talk about the visit tomorrow?",
          threadId: "thread-classify-owner",
          receivedAt: new Date().toISOString(),
        },
      ],
      null,
      async () => null,
      classifyMessage,
      { profile: ownerProfile, geminiEnabled: true },
    );
    assert.equal(modelBodies.some((body) => body.includes(MARKER)), true);
  });

  test("the brief is not written from another mailbox's deployment notes", async () => {
    deploymentProfile();
    installFetch();
    const id = "brief-colleague";
    activeMessageId = id;
    const profile = await loadUserProfile(COLLEAGUE);
    await buildBrief(COLLEAGUE, [emailItem(id)], profile, { messages: 1, threads: 1 });
    assert.equal(modelBodies.some((body) => body.includes(MARKER)), false);

    modelBodies.length = 0;
    const ownerProfile = await loadUserProfile(OWNER_EMAIL);
    await buildBrief(
      OWNER_EMAIL,
      [emailItem("brief-owner")],
      ownerProfile,
      { messages: 1, threads: 1 },
    );
    assert.equal(modelBodies.some((body) => body.includes(MARKER)), true);
  });

  for (const [name, handler] of [
    ["mailbox", () => mailboxGet],
    ["today", () => todayGet],
    ["all-tasks", () => allTasksGet],
  ] as const) {
    test(`${name} classification omits another mailbox's deployment notes`, async () => {
      deploymentProfile();
      installFetch();
      await forgetMailbox(COLLEAGUE);
      const colleague = await sessionCookie(COLLEAGUE);
      activeMessageId = `${name}-colleague`;
      modelBodies.length = 0;
      const response = await withRequest(colleague, () =>
        handler()(new Request(`http://localhost:3000/api/${name}`)),
      );
      assert.equal(response.status, 200, name);
      assert.equal(modelBodies.length > 0, true, name);
      assert.equal(modelBodies.some((body) => body.includes(MARKER)), false);
    });
  }

  test("rebuilding the brief for another mailbox omits the deployment notes", async () => {
    deploymentProfile();
    installFetch();
    await forgetMailbox(COLLEAGUE);
    const colleague = await sessionCookie(COLLEAGUE);
    activeMessageId = "brief-route";
    modelBodies.length = 0;
    const response = await withRequest(colleague, () =>
      briefPost(new Request("http://localhost:3000/api/brief", { method: "POST" })),
    );
    const payload = await response.clone().json().catch(() => null);
    assert.equal(response.status, 200, JSON.stringify(payload));
    assert.equal(
      modelBodies.length > 0,
      true,
      `brief route made no model call: ${JSON.stringify(payload)}`,
    );
    assert.equal(modelBodies.some((body) => body.includes(MARKER)), false);
  });

  test("a reply draft is not written as the owner", async () => {
    deploymentProfile();
    installFetch();
    const colleague = await sessionCookie(COLLEAGUE);
    activeMessageId = "draft-1";
    modelBodies.length = 0;
    const response = await withRequest(colleague, () =>
      draftPost(
        new Request("http://localhost:3000/api/assist/draft", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ id: "draft-1" }),
        }),
      ),
    );
    assert.equal(response.status, 200);
    assert.equal(modelBodies.some((body) => body.includes(MARKER)), false);
  });

  test("VIP suggestions are not scored from another mailbox's notes", async () => {
    deploymentProfile();
    installFetch();
    await kvSet(`mail-history:${COLLEAGUE}`, {
      builtAt: new Date().toISOString(),
      history: {
        accountEmail: COLLEAGUE,
        builtAt: new Date().toISOString(),
        contacts: {
          "zqxvipmarker@example.com": {
            email: "zqxvipmarker@example.com",
            sentTo: 2,
            receivedFrom: 1,
          },
        },
        engagedCount: 1,
        contactCount: 1,
      },
    });
    const colleague = await sessionCookie(COLLEAGUE);
    const response = await withRequest(colleague, () => vipsGet());
    assert.equal(response.status, 200);
    const body = (await response.json()) as {
      suggestions: { email: string; evidence: string }[];
    };
    const suggestion = body.suggestions.find(
      (row) => row.email === "zqxvipmarker@example.com",
    );
    assert.ok(suggestion);
    assert.equal(suggestion.evidence.includes("named in your profile"), false);
  });

  test("the legacy sync job does not classify another mailbox as the owner", async () => {
    deploymentProfile();
    installFetch();
    process.env.SEER_LEGACY_CRON = "on";
    process.env.SEER_V3_LEGACY_ACCOUNT_FALLBACK = "1";
    process.env.CRON_SECRET = "placeholder-cron-secret";
    activeMessageId = "cron-colleague";
    await kvSet("accounts", {
      accounts: [
        {
          id: "acct-colleague",
          provider: "google",
          email: COLLEAGUE,
          name: "Colleague",
          accessToken: ACCESS_TOKEN,
          expiresAt: Math.floor(Date.now() / 1000) + 3600,
          updatedAt: new Date().toISOString(),
        },
      ],
    });
    modelBodies.length = 0;
    const response = await cronGet(
      new Request("http://localhost:3000/api/cron/sync", {
        headers: { authorization: "Bearer placeholder-cron-secret" },
      }),
    );
    assert.equal(response.status, 200);
    const body = (await response.json()) as { disabled?: string; report?: { error?: string }[] };
    assert.equal(body.disabled, undefined);
    assert.equal(modelBodies.length > 0, true, JSON.stringify(body.report));
    assert.equal(modelBodies.some((entry) => entry.includes(MARKER)), false);
  });
});
