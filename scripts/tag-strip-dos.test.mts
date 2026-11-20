/**
 * Spec for the inbox tag-strip denial of service.
 *
 * An HTML-only message whose body is a long run of "<" reaches the tag
 * expression before any length cap. These tests fail while that scan can
 * rescan the rest of the body at every less-than sign, and they pass once
 * every attacker-controlled body is stripped in bounded time.
 *
 * The signed-in session is a stub. The message bytes travel through the
 * real Gmail/Graph parsers and the real route handlers.
 */
import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { registerHooks } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";

const globalAls = globalThis as { AsyncLocalStorage?: typeof AsyncLocalStorage };
if (typeof globalAls.AsyncLocalStorage !== "function") {
  globalAls.AsyncLocalStorage = AsyncLocalStorage;
}

const sessionStub = new URL("./tag-strip-session-stub.mjs", import.meta.url).href;
registerHooks({
  resolve(specifier, context, nextResolve) {
    const resolved = nextResolve(specifier, context);
    if (resolved.url.includes("/src/lib/mail/session.ts")) {
      return { url: sessionStub, shortCircuit: true };
    }
    return resolved;
  },
});

const ATTACK_CHARS = 32_000;
const BUDGET_MS = 400;
const BENIGN_MARKER = "MARKER-END-OF-NOTE";
const dataDir = await mkdtemp(path.join(tmpdir(), "seer-tag-strip-"));

process.env.SEER_DATA_DIR = dataDir;
process.env.GEMINI_API_KEY = "placeholder-not-a-secret";
process.env.SEER_GEMINI_MODEL = "gemini-2.0-flash";
delete process.env.POSTGRES_URL;
delete process.env.DATABASE_URL;
delete process.env.UPSTASH_REDIS_REST_URL;
delete process.env.KV_REST_API_URL;

type Fixture = {
  id: string;
  threadId: string;
  mimeType: "text/html" | "text/plain";
  body: string;
  subject: string;
  snippet: string;
};

let fixture: Fixture = {
  id: "msg-unset",
  threadId: "thr-unset",
  mimeType: "text/html",
  body: "",
  subject: "Workshop notes",
  snippet: "A short note",
};

const modelBodies: string[] = [];
let fullFetches = 0;

function attackHtml(): string {
  return "<".repeat(ATTACK_CHARS);
}

function benignHtml(): string {
  const words = `${"alpha beta gamma delta ".repeat(200)}${BENIGN_MARKER}`;
  return `<html><body><p>${words}</p></body></html>`;
}

function b64url(value: string): string {
  return Buffer.from(value, "utf8").toString("base64url");
}

function gmailMessage(full: boolean) {
  const headers = [
    { name: "From", value: "Attacker <attacker@example.com>" },
    { name: "To", value: "Owner <owner@example.com>" },
    { name: "Subject", value: fixture.subject },
  ];
  return {
    id: fixture.id,
    threadId: fixture.threadId,
    snippet: fixture.snippet,
    internalDate: String(Date.parse("2026-11-01T12:00:00.000Z")),
    labelIds: ["INBOX", "UNREAD"],
    payload: full
      ? {
          mimeType: fixture.mimeType,
          headers,
          body: { size: fixture.body.length, data: b64url(fixture.body) },
        }
      : { headers },
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function installFetch() {
  const original = globalThis.fetch;
  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const host = new URL(url).host;
    const pathname = new URL(url).pathname;
    if (host === "gmail.googleapis.com") {
      if (pathname.endsWith("/messages/send")) {
        return jsonResponse({ id: "sent-1", threadId: fixture.threadId });
      }
      if (pathname.endsWith("/labels")) {
        return jsonResponse({ labels: [] });
      }
      if (url.includes("format=full")) {
        fullFetches += 1;
        return jsonResponse(gmailMessage(true));
      }
      if (url.includes("format=metadata") || url.includes("format=minimal")) {
        if (pathname.includes("/threads/")) {
          return jsonResponse({
            messages: [gmailMessage(false)],
          });
        }
        return jsonResponse(gmailMessage(false));
      }
      if (pathname.endsWith("/messages")) {
        const query = new URL(url).searchParams.get("q") ?? "";
        if (query.startsWith("in:inbox")) {
          return jsonResponse({
            messages: [{ id: fixture.id, threadId: fixture.threadId }],
          });
        }
        return jsonResponse({ messages: [] });
      }
      return jsonResponse({});
    }
    if (host === "people.googleapis.com") {
      return jsonResponse({ connections: [], otherContacts: [] });
    }
    if (host === "www.googleapis.com") {
      return jsonResponse({ items: [] });
    }
    if (
      host === "generativelanguage.googleapis.com" ||
      host.endsWith("ai-gateway.vercel.sh") ||
      host === "ai-gateway.vercel.sh"
    ) {
      const raw = init?.body;
      if (typeof raw === "string") modelBodies.push(raw);
      else if (raw instanceof Uint8Array) modelBodies.push(Buffer.from(raw).toString("utf8"));
      return jsonResponse(
        { error: { message: "placeholder model unavailable" } },
        400,
      );
    }
    return original(input, init);
  };
}

installFetch();

const { createWorkStore } = await import(
  "next/dist/server/async-storage/work-store.js"
);
const { workAsyncStorage } = await import(
  "next/dist/server/app-render/work-async-storage.external.js"
);

const todayRoute = await import("../src/app/api/today/route.ts");
const mailboxRoute = await import("../src/app/api/mailbox/route.ts");
const alltasksRoute = await import("../src/app/api/alltasks/route.ts");
const messageRoute = await import("../src/app/api/messages/[id]/route.ts");
const draftRoute = await import("../src/app/api/assist/draft/route.ts");
const sendRoute = await import("../src/app/api/send/route.ts");
const cronRoute = await import("../src/app/api/cron/sync/route.ts");
const { GmailProvider } = await import("../src/lib/v2/providers/gmail.ts");
const { OutlookProvider } = await import("../src/lib/v2/providers/outlook.ts");
const { storedBodyText } = await import("../src/lib/v2/intelligence/html-text.ts");
const { shapeThread } = await import("../src/lib/v3/reader/thread-shape.ts");
const { quoteBody } = await import("../src/lib/v2/client/reply.ts");
const { extractKeyActions } = await import("../src/lib/inbox/key-actions.ts");

function useFixture(partial: Partial<Fixture> & Pick<Fixture, "id" | "body" | "mimeType">) {
  fixture = {
    threadId: `thr-${partial.id}`,
    subject: "Workshop notes",
    snippet: "A short note",
    ...partial,
  };
  fullFetches = 0;
  modelBodies.length = 0;
}

async function flushAfter<T>(page: string, run: () => Promise<T>): Promise<T> {
  const tasks: Promise<unknown>[] = [];
  let release: (() => void) | undefined;
  const store = createWorkStore({
    page,
    renderOpts: {
      experimental: {},
      supportsDynamicResponse: true,
      waitUntil: (task: Promise<unknown>) => {
        tasks.push(Promise.resolve(task));
      },
      onClose: (done: () => void) => {
        release = done;
      },
    },
    isPrefetchRequest: false,
    buildId: "tag-strip-test",
  });
  const result = await workAsyncStorage.run(store, run);
  if (release) release();
  await Promise.all(tasks);
  return result;
}

async function timed<T>(run: () => Promise<T>): Promise<{ result: T; elapsed: number }> {
  const started = Date.now();
  const result = await run();
  return { result, elapsed: Date.now() - started };
}

const failures: string[] = [];

async function check(name: string, run: () => Promise<void>) {
  try {
    await run();
    console.log(`PASS ${name}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    failures.push(`${name}: ${message}`);
    console.error(`FAIL ${name}: ${message}`);
  }
}

function assertFast(name: string, elapsed: number) {
  assert.ok(
    elapsed < BUDGET_MS,
    `${name} took ${elapsed}ms, budget is ${BUDGET_MS}ms`,
  );
}

await check("today grades an html-only less-than body within the budget", async () => {
  useFixture({ id: "msg-today", mimeType: "text/html", body: attackHtml() });
  const { result, elapsed } = await timed(() =>
    flushAfter("/api/today", () => todayRoute.GET()),
  );
  const payload = await result.json();
  assert.equal(result.status, 200, JSON.stringify(payload));
  assert.ok(payload.assistant?.pending >= 1, "ungraded mail was not queued");
  assert.ok(fullFetches >= 1, "the grade never downloaded the message");
  assertFast("today", elapsed);
});

await check("today still deep-reads a normal html message", async () => {
  useFixture({
    id: "msg-today-benign",
    mimeType: "text/html",
    body: benignHtml(),
    snippet: "preview",
  });
  const { result, elapsed } = await timed(() =>
    flushAfter("/api/today", () => todayRoute.GET()),
  );
  assert.equal(result.status, 200);
  assert.ok(modelBodies.some((body) => body.includes(BENIGN_MARKER)));
  assertFast("today benign", elapsed);
});

await check("a plain-text less-than body does not stall today", async () => {
  useFixture({ id: "msg-today-text", mimeType: "text/plain", body: attackHtml() });
  const { result, elapsed } = await timed(() =>
    flushAfter("/api/today", () => todayRoute.GET()),
  );
  assert.equal(result.status, 200);
  assert.ok(fullFetches >= 1);
  assertFast("today text", elapsed);
});

await check("mailbox grades an html-only less-than body within the budget", async () => {
  useFixture({ id: "msg-mailbox", mimeType: "text/html", body: attackHtml() });
  const { result, elapsed } = await timed(() =>
    flushAfter("/api/mailbox", () =>
      mailboxRoute.GET(new Request("http://localhost/api/mailbox")),
    ),
  );
  assert.equal(result.status, 200, await result.clone().text());
  assert.ok(fullFetches >= 1);
  assertFast("mailbox", elapsed);
});

await check("alltasks grades an html-only less-than body within the budget", async () => {
  useFixture({ id: "msg-alltasks", mimeType: "text/html", body: attackHtml() });
  const { result, elapsed } = await timed(() => alltasksRoute.GET());
  assert.equal(result.status, 200, await result.clone().text());
  assert.ok(fullFetches >= 1);
  assertFast("alltasks", elapsed);
});

await check("opening a message strips html before the handler returns", async () => {
  useFixture({ id: "msg-reader", mimeType: "text/html", body: attackHtml() });
  const { result, elapsed } = await timed(() =>
    messageRoute.GET(new Request("http://localhost/api/messages/msg-reader"), {
      params: Promise.resolve({ id: "msg-reader" }),
    }),
  );
  assert.equal(result.status, 200, await result.clone().text());
  assert.ok(fullFetches >= 1);
  assertFast("message", elapsed);
});

await check("a draft reads the html body within the budget", async () => {
  useFixture({ id: "msg-draft", mimeType: "text/html", body: attackHtml() });
  const { result, elapsed } = await timed(() =>
    draftRoute.POST(
      new Request("http://localhost/api/assist/draft", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: "msg-draft", intent: "yes" }),
      }),
    ),
  );
  assert.ok(fullFetches >= 1);
  assert.notEqual(result.status, 401);
  assertFast("draft", elapsed);
});

await check("forwarding quotes the html body within the budget", async () => {
  useFixture({ id: "msg-forward", mimeType: "text/html", body: attackHtml() });
  const { result, elapsed } = await timed(() =>
    sendRoute.POST(
      new Request("http://localhost/api/send", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          mode: "forward",
          replyToId: "msg-forward",
          to: "delegate@example.com",
          body: "Please take this",
        }),
      }),
    ),
  );
  assert.equal(result.status, 200, await result.clone().text());
  assert.ok(fullFetches >= 1);
  assertFast("forward", elapsed);
});

await check("legacy cron grades an html-only less-than body within the budget", async () => {
  process.env.SEER_LEGACY_CRON = "on";
  process.env.SEER_V3_LEGACY_ACCOUNT_FALLBACK = "1";
  await writeFile(
    path.join(dataDir, "accounts.json"),
    JSON.stringify({
      accounts: [
        {
          id: "acct-test",
          provider: "google",
          email: "owner@example.com",
          name: "Owner",
          accessToken: "placeholder-access-token",
          expiresAt: Math.floor(Date.now() / 1000) + 86_400,
          updatedAt: "2026-11-01T00:00:00.000Z",
        },
      ],
    }),
  );
  useFixture({ id: "msg-cron", mimeType: "text/html", body: attackHtml() });
  const { result, elapsed } = await timed(() =>
    cronRoute.GET(new Request("http://localhost/api/cron/sync")),
  );
  assert.equal(result.status, 200, await result.clone().text());
  assert.ok(fullFetches >= 1, "cron never downloaded the message");
  assertFast("cron", elapsed);
});

await check("gmail sync stores text from an html-only less-than body within the budget", async () => {
  const html = attackHtml();
  const provider = new GmailProvider({
    accessToken: "placeholder-access-token",
    accountEmail: "owner@example.com",
    fetchImpl: async (url) => {
      const href = String(url);
      if (href.includes("/threads?")) {
        return jsonResponse({ threads: [{ id: "thr-sync" }], resultSizeEstimate: 1 });
      }
      return jsonResponse({
        id: "thr-sync",
        messages: [
          {
            id: "msg-sync",
            threadId: "thr-sync",
            snippet: "A short note",
            internalDate: String(Date.parse("2026-11-01T12:00:00.000Z")),
            labelIds: ["INBOX", "UNREAD"],
            payload: {
              mimeType: "text/html",
              headers: [
                { name: "From", value: "Attacker <attacker@example.com>" },
                { name: "To", value: "Owner <owner@example.com>" },
                { name: "Subject", value: "Workshop notes" },
              ],
              body: { size: html.length, data: b64url(html) },
            },
          },
        ],
      });
    },
  });
  const { result, elapsed } = await timed(async () => {
    const page = await provider.syncFolder("inbox", null, { pageSize: 1 });
    const message = page.conversations[0]?.messages[0];
    assert.ok(message, "gmail sync did not return the message");
    assert.equal(message.bodyText, null);
    assert.ok((message.bodyHtml?.length ?? 0) >= ATTACK_CHARS);
    return storedBodyText(message);
  });
  assert.equal(typeof result, "string");
  assertFast("gmail storedBodyText", elapsed);
});

await check("outlook sync stores text from an html body within the budget", async () => {
  const html = attackHtml();
  const provider = new OutlookProvider({
    accessToken: "placeholder-access-token",
    accountEmail: "owner@example.com",
    pageSize: 1,
    fetchImpl: async (url) => {
      const href = String(url);
      if (href.includes("/mailFolders/inbox?")) {
        return jsonResponse({ totalItemCount: 1 });
      }
      if (href.includes("/mailFolders/inbox/messages")) {
        return jsonResponse({
          value: [
            {
              id: "msg-outlook",
              conversationId: "conv-outlook",
              subject: "Workshop notes",
              from: { emailAddress: { address: "attacker@example.com", name: "Attacker" } },
              toRecipients: [{ emailAddress: { address: "owner@example.com", name: "Owner" } }],
              receivedDateTime: "2026-11-01T12:00:00.000Z",
              bodyPreview: "A short note",
              isRead: false,
              hasAttachments: false,
            },
          ],
        });
      }
      return jsonResponse({
        value: [
          {
            id: "msg-outlook",
            conversationId: "conv-outlook",
            subject: "Workshop notes",
            from: { emailAddress: { address: "attacker@example.com", name: "Attacker" } },
            toRecipients: [{ emailAddress: { address: "owner@example.com", name: "Owner" } }],
            receivedDateTime: "2026-11-01T12:00:00.000Z",
            bodyPreview: "",
            body: { contentType: "html", content: html },
            isRead: false,
            hasAttachments: false,
          },
        ],
      });
    },
  });
  const { result, elapsed } = await timed(async () => {
    const page = await provider.syncFolder("inbox", null, { pageSize: 1 });
    const message = page.conversations[0]?.messages[0];
    assert.ok(message);
    assert.equal(message.bodyText, null);
    assert.ok((message.bodyHtml?.length ?? 0) >= ATTACK_CHARS);
    return storedBodyText(message);
  });
  assert.equal(typeof result, "string");
  assertFast("outlook storedBodyText", elapsed);
});

await check("the reader shapes an html less-than body within the budget", async () => {
  const html = attackHtml();
  const { elapsed } = await timed(async () => {
    shapeThread(
      {
        providerConversationId: "conv-reader",
        subject: "Workshop notes",
        lastMessageAt: "2026-11-01T12:00:00.000Z",
        messages: [
          {
            providerMessageId: "msg-shape",
            from: { email: "attacker@example.com", name: "Attacker" },
            to: [{ email: "owner@example.com", name: "Owner" }],
            cc: [],
            sentAt: "2026-11-01T12:00:00.000Z",
            snippet: "A short note",
            bodyHtml: html,
            bodyText: null,
            isUnread: true,
            isOutgoing: false,
            attachments: [],
          },
        ],
      },
      "example.com",
      "owner@example.com",
    );
  });
  assertFast("shapeThread", elapsed);
});

await check("quoting an html body with no text part stays within the budget", async () => {
  const html = attackHtml();
  const { elapsed } = await timed(async () => {
    quoteBody({
      providerConversationId: "conv-quote",
      subject: "Workshop notes",
      lastMessageAt: "2026-11-01T12:00:00.000Z",
      messages: [
        {
          providerMessageId: "msg-quote",
          from: { email: "attacker@example.com", name: "Attacker" },
          to: [{ email: "owner@example.com" }],
          cc: [],
          sentAt: "2026-11-01T12:00:00.000Z",
          snippet: "A short note",
          bodyHtml: html,
          bodyText: null,
          isUnread: true,
          isOutgoing: false,
          attachments: [],
        },
      ],
    });
  });
  assertFast("quoteBody", elapsed);
});

await check("key actions strip a less-than run inside an anchor within the budget", async () => {
  const html = `<a href="https://example.com/pay">pay now ${"<".repeat(ATTACK_CHARS)}</a>`;
  const { elapsed } = await timed(async () => {
    extractKeyActions(html, "act_today");
  });
  assertFast("extractKeyActions", elapsed);
});

await rm(dataDir, { recursive: true, force: true });

if (failures.length > 0) {
  console.error(`\n${failures.length} test(s) failed`);
  process.exit(1);
}
console.log("\nall tag-strip tests passed");
