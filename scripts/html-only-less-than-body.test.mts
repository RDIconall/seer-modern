/**
 * An HTML-only message whose body is a long run of "<" must not stall the
 * paths that turn that body into text.
 *
 * These tests fail while that replace backtracks. They pass once every copy
 * finishes in linear time (a length cap or a scan that does not retry).
 *
 * Run:
 *   node --import tsx scripts/html-only-less-than-body.test.mts
 *
 * Not covered here, and why:
 * - src/lib/v2/client/reply.ts quoteBody — nothing in the repo calls it.
 * - src/lib/v2/providers/fake.ts — test double; it scans the composer's own
 *   HTML, which an outside sender cannot supply.
 * - src/lib/inbox/key-actions.ts stripTags — only runs on text already inside
 *   an anchor, and a pure less-than run never matches an anchor.
 * - src/lib/v3/reader/email-html.ts textBefore — the same replace, but only on
 *   a 600-character slice, so it cannot stall the request on its own.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { registerHooks } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";

const sessionStub = new URL("./stubs/mail-session-stub.mjs", import.meta.url).href;
const nextShim = new URL("./stubs/next-server-shim.mjs", import.meta.url).href;

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (
      specifier === "@/lib/mail/session" ||
      /\/lib\/mail\/session\.ts$/.test(specifier)
    ) {
      return { url: sessionStub, shortCircuit: true };
    }
    const parent = context.parentURL ?? "";
    if (specifier === "next/server" && !parent.endsWith("/next-server-shim.mjs")) {
      return { url: nextShim, shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
});

const dataDir = mkdtempSync(path.join(tmpdir(), "seer-html-only-"));
process.env.NODE_ENV = "test";
process.env.SEER_DATA_DIR = dataDir;
process.env.GEMINI_API_KEY = "placeholder";
process.env.SEER_LEGACY_CRON = "on";
process.env.SEER_V3_LEGACY_ACCOUNT_FALLBACK = "1";
for (const name of [
  "SEER_V2_DATABASE_URL",
  "POSTGRES_URL",
  "POSTGRES_PRISMA_URL",
  "DATABASE_URL",
  "UPSTASH_REDIS_REST_URL",
  "UPSTASH_REDIS_REST_TOKEN",
  "KV_REST_API_URL",
  "KV_REST_API_TOKEN",
  "OPENAI_API_KEY",
  "VERCEL",
  "VERCEL_OIDC_TOKEN",
  "AI_GATEWAY_API_KEY",
  "CRON_SECRET",
]) {
  delete process.env[name];
}

/** Long enough that the quadratic replace exceeds BUDGET_MS on this runtime. */
const ATTACK_LENGTH = 80_000;
const BUDGET_MS = 2_000;
const MESSAGE_ID = "m1";
const THREAD_ID = "thread-1";

type BodyKind = "attack" | "normal" | "plain";

function htmlFor(kind: BodyKind): { html: string; text?: string } {
  if (kind === "normal") {
    const unit = "<p>Please countersign the CDA by Friday.</p>";
    return { html: unit.repeat(Math.ceil(ATTACK_LENGTH / unit.length)) };
  }
  const html = "<".repeat(ATTACK_LENGTH);
  if (kind === "plain") return { html, text: "Hello from the plain part." };
  return { html };
}

function base64Url(value: string): string {
  return Buffer.from(value, "utf8").toString("base64url");
}

function gmailMessage(kind: BodyKind) {
  const { html, text } = htmlFor(kind);
  const parts = [];
  if (text !== undefined) {
    parts.push({
      mimeType: "text/plain",
      body: { data: base64Url(text), size: Buffer.byteLength(text) },
    });
  }
  parts.push({
    mimeType: "text/html",
    body: { data: base64Url(html), size: Buffer.byteLength(html) },
  });
  return {
    id: MESSAGE_ID,
    threadId: THREAD_ID,
    snippet: "preview",
    internalDate: String(Date.now()),
    labelIds: ["INBOX", "UNREAD"],
    payload: {
      mimeType: "multipart/alternative",
      headers: [
        { name: "From", value: "Attacker <attacker@example.com>" },
        { name: "To", value: "victim@example.com" },
        { name: "Subject", value: "Note" },
        { name: "Cc", value: "" },
        { name: "Message-ID", value: "<m1@example.com>" },
      ],
      parts,
    },
  };
}

function gmailMetadata() {
  return {
    id: MESSAGE_ID,
    threadId: THREAD_ID,
    snippet: "preview",
    internalDate: String(Date.now()),
    labelIds: ["INBOX", "UNREAD"],
    payload: {
      headers: [
        { name: "From", value: "Attacker <attacker@example.com>" },
        { name: "To", value: "victim@example.com" },
        { name: "Subject", value: "Note" },
      ],
    },
  };
}

function graphMessage(kind: BodyKind) {
  const { html, text } = htmlFor(kind);
  const htmlBody = kind === "plain" ? text! : html;
  const contentType = kind === "plain" ? "text" : "html";
  return {
    id: MESSAGE_ID,
    conversationId: THREAD_ID,
    subject: "Note",
    bodyPreview: kind === "plain" ? text : "",
    body: { contentType, content: htmlBody },
    receivedDateTime: new Date().toISOString(),
    isRead: false,
    hasAttachments: false,
    from: { emailAddress: { name: "Attacker", address: "attacker@example.com" } },
    toRecipients: [{ emailAddress: { name: "Victim", address: "victim@example.com" } }],
    ccRecipients: [],
    internetMessageId: "<m1@example.com>",
  };
}

type FetchState = { kind: BodyKind; calls: string[] };

function installFetch(state: FetchState) {
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const raw = input instanceof Request ? input.url : String(input);
    const url = new URL(raw);
    state.calls.push(`${init?.method ?? "GET"} ${url.origin}${url.pathname}`);
    const json = (body: unknown, status = 200) =>
      new Response(body === null ? null : JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      });

    if (url.hostname === "gmail.googleapis.com") {
      const path = url.pathname;
      if (path.endsWith("/messages/send")) return json({ id: "sent-1", threadId: THREAD_ID });
      if (path.endsWith("/modify") || path.endsWith("/trash")) return json({});
      if (path.includes("/labels")) return json({ labels: [], messagesTotal: 1, threadsTotal: 1 });
      if (path.includes("/threads/") && url.searchParams.get("format") === "full") {
        return json({ id: THREAD_ID, messages: [gmailMessage(state.kind)] });
      }
      if (path.includes("/threads/") && url.searchParams.get("format") === "minimal") {
        return json({ id: THREAD_ID, messages: [{ id: MESSAGE_ID }] });
      }
      if (path.includes("/threads/")) {
        return json({
          messages: [
            {
              id: MESSAGE_ID,
              internalDate: String(Date.now()),
              labelIds: ["INBOX"],
              payload: {
                headers: [{ name: "From", value: "Attacker <attacker@example.com>" }],
              },
            },
          ],
        });
      }
      if (path.endsWith(`/messages/${MESSAGE_ID}`) && url.searchParams.get("format") === "full") {
        return json(gmailMessage(state.kind));
      }
      if (path.endsWith(`/messages/${MESSAGE_ID}`)) return json(gmailMetadata());
      if (path.endsWith("/messages")) {
        const q = url.searchParams.get("q") ?? "";
        const inInbox = q.startsWith("in:inbox");
        return json({
          messages: inInbox ? [{ id: MESSAGE_ID, threadId: THREAD_ID }] : [],
        });
      }
      if (path.endsWith("/threads")) {
        const q = url.searchParams.get("q") ?? "";
        return json({
          threads: q.startsWith("in:inbox") ? [{ id: THREAD_ID }] : [],
          resultSizeEstimate: q.startsWith("in:inbox") ? 1 : 0,
        });
      }
      return json({});
    }

    if (url.hostname === "graph.microsoft.com") {
      const path = url.pathname;
      if (path.includes("/mailFolders/")) return json({ value: [] });
      if (url.searchParams.has("$filter")) return json({ value: [{ id: MESSAGE_ID }] });
      if (path.includes(`/messages/${MESSAGE_ID}`)) return json(graphMessage(state.kind));
      if (path.endsWith("/sendMail") || path.endsWith("/reply") || path.endsWith("/replyAll")) {
        return new Response(null, { status: 202 });
      }
      return json({ value: [] });
    }

    if (url.hostname === "people.googleapis.com" || url.hostname.endsWith("calendar.googleapis.com")) {
      return json({ connections: [], otherContacts: [], items: [] });
    }

    return json({ error: { message: "placeholder refused" } }, 400);
  }) as typeof fetch;
}

function sessionFor(email: string, provider: "google" | "microsoft-entra-id") {
  globalThis.__seerMailSession = {
    accessToken: "placeholder-token",
    provider,
    email,
    name: "Victim",
    accountId: "account-1",
  };
}

async function settleAfter() {
  const pending = globalThis.__seerHtmlOnlyAfterTasks ?? [];
  globalThis.__seerHtmlOnlyAfterTasks = [];
  await Promise.all(pending);
}

let failures = 0;
async function check(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    console.log(`  ok   ${name}`);
  } catch (error) {
    failures += 1;
    console.error(`  FAIL ${name}`);
    console.error(`       ${error instanceof Error ? error.message : error}`);
  }
}

const { getGmailMessage } = await import("../src/lib/mail/gmail.ts");
const { GmailProvider } = await import("../src/lib/v2/providers/gmail.ts");
const { storedBodyText } = await import("../src/lib/v2/intelligence/html-text.ts");
const { messageFromReadRow } = await import("../src/lib/v2/intelligence/load-conversation.ts");
const { shapeThread } = await import("../src/lib/v3/reader/thread-shape.ts");
const { kvSet } = await import("../src/lib/store/kv.ts");
const { GET: getMessage } = await import("../src/app/api/messages/[id]/route.ts");
const { GET: getToday } = await import("../src/app/api/today/route.ts");
const { GET: getMailbox } = await import("../src/app/api/mailbox/route.ts");
const { GET: getAllTasks } = await import("../src/app/api/alltasks/route.ts");
const { GET: getCron } = await import("../src/app/api/cron/sync/route.ts");
const { POST: postSend } = await import("../src/app/api/send/route.ts");
const { POST: postDraft } = await import("../src/app/api/assist/draft/route.ts");

function messageParams() {
  return { params: Promise.resolve({ id: MESSAGE_ID }) };
}

async function seedLegacyAccount(email: string) {
  await kvSet("accounts", {
    accounts: [
      {
        id: "account-1",
        provider: "google",
        email,
        name: "Victim",
        accessToken: "placeholder-token",
        refreshToken: "placeholder-token",
        expiresAt: Math.floor(Date.now() / 1000) + 60 * 60,
        updatedAt: new Date().toISOString(),
      },
    ],
  });
}

type HandlerResult = { status: number; elapsed: number; calls: string[]; body: string };

async function runHandler(
  email: string,
  kind: BodyKind,
  provider: "google" | "microsoft-entra-id",
  invoke: () => Promise<Response>,
): Promise<HandlerResult> {
  const state: FetchState = { kind, calls: [] };
  installFetch(state);
  sessionFor(email, provider);
  const started = performance.now();
  const response = await invoke();
  await settleAfter();
  const elapsed = performance.now() - started;
  const body = await response.text();
  return { status: response.status, elapsed, calls: state.calls, body };
}

function assertFast(name: string, result: HandlerResult, status?: number) {
  assert.ok(
    result.elapsed < BUDGET_MS,
    `${name} took ${result.elapsed.toFixed(0)}ms (budget ${BUDGET_MS}ms) status=${result.status} body=${result.body.slice(0, 240)}`,
  );
  if (status !== undefined) {
    assert.equal(result.status, status, result.body.slice(0, 400));
  }
}

function loadedFullGmail(calls: string[]) {
  return calls.some((call) => call.includes(`/messages/${MESSAGE_ID}`));
}

console.log("html-only less-than body");

await check("gmail full fetch yields an empty text part and the html part", async () => {
  const state: FetchState = { kind: "attack", calls: [] };
  installFetch(state);
  const message = await getGmailMessage("placeholder-token", MESSAGE_ID);
  assert.equal(message.textBody, "");
  assert.equal(message.htmlBody, "<".repeat(ATTACK_LENGTH));
});

await check("message view renders a normal html-only body within the budget", async () => {
  const result = await runHandler("victim-message-normal@example.com", "normal", "google", () =>
    getMessage(new Request("http://localhost/api/messages/m1"), messageParams()),
  );
  assertFast("message view normal", result, 200);
  assert.ok(loadedFullGmail(result.calls), "message view never fetched the full body");
});

await check("message view stays within the budget when a plain part exists", async () => {
  const result = await runHandler("victim-message-plain@example.com", "plain", "google", () =>
    getMessage(new Request("http://localhost/api/messages/m1"), messageParams()),
  );
  assertFast("message view plain", result, 200);
  const json = JSON.parse(result.body) as { message?: { textBody?: string } };
  assert.equal(json.message?.textBody, "Hello from the plain part.");
});

const harnessFailures = failures;
if (harnessFailures > 0) {
  console.error(`harness failed (${harnessFailures}); not running the stall cases`);
  rmSync(dataDir, { recursive: true, force: true });
  process.exit(1);
}

await check("message view reads an html-only run of less-than signs within the budget", async () => {
  const result = await runHandler("victim-message-attack@example.com", "attack", "google", () =>
    getMessage(new Request("http://localhost/api/messages/m1"), messageParams()),
  );
  assertFast("message view attack", result, 200);
  assert.ok(loadedFullGmail(result.calls), "message view never fetched the full body");
});

await check("outlook message view reads an html body with an empty preview within the budget", async () => {
  const result = await runHandler("victim-graph-attack@example.com", "attack", "microsoft-entra-id", () =>
    getMessage(new Request("http://localhost/api/messages/m1"), messageParams()),
  );
  assertFast("graph message view", result, 200);
  assert.ok(
    result.calls.some((call) => call.includes("graph.microsoft.com") && call.includes(`/messages/${MESSAGE_ID}`)),
    "graph message was never loaded",
  );
});

await check("today deepens an html-only message within the budget", async () => {
  const result = await runHandler("victim-today-attack@example.com", "attack", "google", () => getToday());
  assertFast("today", result, 200);
  assert.ok(loadedFullGmail(result.calls), "today never deepened the message");
});

await check("mailbox deepens an html-only message within the budget", async () => {
  const result = await runHandler(
    "victim-mailbox-attack@example.com",
    "attack",
    "google",
    () => getMailbox(new Request("http://localhost/api/mailbox")),
  );
  assertFast("mailbox", result, 200);
  assert.ok(loadedFullGmail(result.calls), "mailbox never deepened the message");
});

await check("all-tasks deepens an html-only message within the budget", async () => {
  const result = await runHandler("victim-tasks-attack@example.com", "attack", "google", () => getAllTasks());
  assertFast("alltasks", result, 200);
  assert.ok(loadedFullGmail(result.calls), "all-tasks never deepened the message");
});

await check("reply quotes an html-only original within the budget", async () => {
  const result = await runHandler("victim-send-attack@example.com", "attack", "google", () =>
    postSend(
      new Request("http://localhost/api/send", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ mode: "reply", body: "Thanks", replyToId: MESSAGE_ID }),
      }),
    ),
  );
  assertFast("send reply", result, 200);
  assert.ok(
    result.calls.some((call) => call.includes("/messages/send")),
    "reply never reached send",
  );
});

await check("draft reads an html-only message within the budget", async () => {
  const result = await runHandler("victim-draft-attack@example.com", "attack", "google", () =>
    postDraft(
      new Request("http://localhost/api/assist/draft", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: MESSAGE_ID }),
      }),
    ),
  );
  assertFast("draft", result);
  assert.ok(loadedFullGmail(result.calls), "draft never loaded the message");
  assert.ok(result.status === 200 || result.status === 502, result.body.slice(0, 300));
});

await check("legacy cron deepens an html-only message within the budget", async () => {
  const email = "victim-cron-attack@example.com";
  await seedLegacyAccount(email);
  const result = await runHandler(email, "attack", "google", () =>
    getCron(new Request("http://localhost/api/cron/sync")),
  );
  assertFast("cron", result, 200);
  assert.ok(loadedFullGmail(result.calls), "cron never loaded the message body");
  assert.equal(JSON.parse(result.body).disabled, undefined);
});

await check("synced gmail html-only body becomes text within the budget", async () => {
  const state: FetchState = { kind: "attack", calls: [] };
  const provider = new GmailProvider({
    accessToken: "placeholder-token",
    accountEmail: "victim-sync@example.com",
    fetchImpl: (async (input: string | URL | Request, init?: RequestInit) => {
      installFetch(state);
      return globalThis.fetch(input, init);
    }) as typeof fetch,
    pageSize: 5,
  });
  // installFetch replaces global fetch; the provider uses fetchImpl, which
  // delegates to whatever global fetch is after that assignment.
  installFetch(state);
  const page = await provider.syncFolder("inbox");
  const message = page.conversations[0]?.messages[0];
  assert.ok(message, "sync did not return the message");
  assert.equal(message.bodyText, null);
  assert.equal(message.bodyHtml, "<".repeat(ATTACK_LENGTH));
  const started = performance.now();
  const text = storedBodyText({
    bodyText: message.bodyText,
    bodyHtml: message.bodyHtml,
  });
  const elapsed = performance.now() - started;
  assert.ok(elapsed < BUDGET_MS, `storedBodyText took ${elapsed.toFixed(0)}ms`);
  assert.equal(typeof text, "string");
});

await check("a stored html-only row is readable within the budget", async () => {
  const started = performance.now();
  const message = messageFromReadRow({
    provider_message_id: MESSAGE_ID,
    from_email: "attacker@example.com",
    from_name: "Attacker",
    to_emails: ["victim@example.com"],
    cc_emails: [],
    sent_at: new Date().toISOString(),
    body_html: "<".repeat(ATTACK_LENGTH),
    body_text: null,
    snippet: "preview",
    is_unread: true,
    is_outgoing: false,
    attachment_names: [],
  });
  const elapsed = performance.now() - started;
  assert.ok(message, "row was dropped");
  assert.ok(elapsed < BUDGET_MS, `messageFromReadRow took ${elapsed.toFixed(0)}ms`);
  assert.equal(typeof message.bodyText, "string");
});

await check("the reader shapes an html-only run of less-than signs within the budget", async () => {
  const sentAt = new Date().toISOString();
  const started = performance.now();
  const lanes = shapeThread(
    {
      providerConversationId: THREAD_ID,
      subject: "Note",
      lastMessageAt: sentAt,
      messages: [
        {
          providerMessageId: MESSAGE_ID,
          from: { email: "attacker@example.com", name: "Attacker" },
          to: [{ email: "victim@example.com" }],
          cc: [],
          sentAt,
          snippet: "preview",
          bodyHtml: "<".repeat(ATTACK_LENGTH),
          bodyText: null,
          isUnread: true,
          isOutgoing: false,
          attachments: [],
        },
      ],
    },
    "victim.test",
    "victim@example.com",
  );
  const elapsed = performance.now() - started;
  assert.ok(elapsed < BUDGET_MS, `shapeThread took ${elapsed.toFixed(0)}ms`);
  assert.ok(lanes.length > 0);
});

await check("a normal html body still becomes the sentence a person would read", async () => {
  const text = storedBodyText({
    bodyText: null,
    bodyHtml: "<p>Please countersign the CDA by Friday.</p>",
  });
  assert.equal(text, "Please countersign the CDA by Friday.");
});

rmSync(dataDir, { recursive: true, force: true });
if (failures > 0) {
  console.error(`${failures} failed`);
  process.exit(1);
}
console.log("all passed");
