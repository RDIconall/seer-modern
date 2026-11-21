/**
 * Spec for HTML tag stripping on attacker-controlled mail.
 *
 * These tests fail while a full HTML body of less-than signs is scanned with
 * /<[^>]+>/ before any character budget. They pass once every body that is
 * turned into text for grading or reading is cut to a fixed budget first and
 * stripped with a single left-to-right scan.
 *
 * Run:
 *   NODE_OPTIONS='--experimental-test-module-mocks' npx tsx scripts/tag-strip-dos.test.mts
 *
 * The suite is expected to fail until that fix lands.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { mock } from "node:test";
import { tmpdir } from "node:os";
import path from "node:path";

// Next's after() store is created at import time and only uses a real
// AsyncLocalStorage when this global exists. Set it before Next loads.
(globalThis as { AsyncLocalStorage?: typeof AsyncLocalStorage }).AsyncLocalStorage =
  AsyncLocalStorage;

const ATTACK_CHARS = 80_000;
const BUDGET_MS = 500;
const ATTACK_HTML = "<".repeat(ATTACK_CHARS);
const BENIGN_SENTENCE =
  "Please review the contract and send the signed copy back today.";
const BENIGN_HTML = `<div><p>${BENIGN_SENTENCE.repeat(4)}</p></div>`;
const SUBJECT = "Quarterly planning note";
const FROM = "Stranger <stranger@example.com>";
const MESSAGE_ID = "msg-1";
const THREAD_ID = "thr-1";

type BodyKind = "html-attack" | "html-benign" | "plain-attack";

const state: { kind: BodyKind } = { kind: "html-attack" };

function htmlFor(kind: BodyKind): string {
  if (kind === "html-benign") return BENIGN_HTML;
  return ATTACK_HTML;
}

function gmailMessage(kind: BodyKind, format: "full" | "metadata") {
  const headers = [
    { name: "From", value: FROM },
    { name: "To", value: "Owner <owner@example.com>" },
    { name: "Subject", value: SUBJECT },
    { name: "Message-ID", value: "<m@example.com>" },
  ];
  if (format === "metadata") {
    return {
      id: MESSAGE_ID,
      threadId: THREAD_ID,
      snippet: "preview",
      internalDate: String(Date.now()),
      labelIds: ["INBOX", "UNREAD"],
      payload: { mimeType: "text/html", headers },
    };
  }
  const plain = kind === "plain-attack";
  return {
    id: MESSAGE_ID,
    threadId: THREAD_ID,
    snippet: "preview",
    internalDate: String(Date.now()),
    labelIds: ["INBOX", "UNREAD"],
    payload: {
      mimeType: plain ? "text/plain" : "text/html",
      headers,
      body: {
        data: Buffer.from(plain ? ATTACK_HTML : htmlFor(kind), "utf8").toString(
          "base64url",
        ),
      },
    },
  };
}

function graphMessage(kind: BodyKind, withBody: boolean) {
  const html = kind !== "plain-attack";
  return {
    id: MESSAGE_ID,
    conversationId: THREAD_ID,
    subject: SUBJECT,
    bodyPreview: html ? "" : ATTACK_HTML.slice(0, 255),
    receivedDateTime: new Date().toISOString(),
    isRead: false,
    from: { emailAddress: { name: "Stranger", address: "stranger@example.com" } },
    toRecipients: [
      { emailAddress: { name: "Owner", address: "owner@example.com" } },
    ],
    internetMessageId: "<m@example.com>",
    ...(withBody
      ? {
          body: html
            ? { contentType: "html", content: htmlFor(kind) }
            : { contentType: "text", content: ATTACK_HTML },
        }
      : {}),
  };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function installFetch() {
  const calls: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input : input.url);
    calls.push(`${url.hostname}${url.pathname}`);
    const pathAndQuery = `${url.pathname}${url.search}`;

    if (url.hostname === "gmail.googleapis.com") {
      if (pathAndQuery.includes("/messages/send") || pathAndQuery.includes("/modify") || pathAndQuery.includes("/trash")) {
        return json({ id: MESSAGE_ID, threadId: THREAD_ID });
      }
      if (pathAndQuery.includes(`/threads/${THREAD_ID}`)) {
        return json({
          id: THREAD_ID,
          messages: [gmailMessage(state.kind, pathAndQuery.includes("format=full") ? "full" : "metadata")],
        });
      }
      if (pathAndQuery.includes(`/messages/${MESSAGE_ID}`)) {
        const format = pathAndQuery.includes("format=full") ? "full" : "metadata";
        return json(gmailMessage(state.kind, format));
      }
      if (pathAndQuery.includes("/messages")) {
        const q = url.searchParams.get("q") ?? "";
        const inbox = q.includes("in:inbox") && !q.includes("-in:inbox");
        return json(
          inbox
            ? { messages: [{ id: MESSAGE_ID, threadId: THREAD_ID }] }
            : { messages: [] },
        );
      }
      if (pathAndQuery.includes("/labels")) return json({ labels: [] });
      return json({});
    }

    if (url.hostname === "graph.microsoft.com") {
      if (pathAndQuery.includes("/sendMail") || pathAndQuery.includes("/reply") || pathAndQuery.includes("/forward") || pathAndQuery.includes("/move")) {
        return json({});
      }
      if (pathAndQuery.includes(`/messages/${MESSAGE_ID}`)) {
        return json(graphMessage(state.kind, true));
      }
      if (pathAndQuery.includes("/mailFolders/inbox/messages")) {
        return json({ value: [graphMessage(state.kind, false)] });
      }
      if (pathAndQuery.includes("/messages")) return json({ value: [] });
      return json({ value: [] });
    }

    return json({});
  }) as typeof fetch;
  return calls;
}

const session = {
  email: "owner@example.com",
  accessToken: "test-token",
  provider: "google" as string,
  name: "Owner",
};

const prompts: string[] = [];

mock.module("@/lib/mail/session", {
  namedExports: {
    requireMailSession: async () => session,
  },
});

mock.module("ai", {
  namedExports: {
    generateText: async (args: { prompt?: unknown }) => {
      prompts.push(typeof args?.prompt === "string" ? args.prompt : JSON.stringify(args?.prompt ?? ""));
      return { output: { items: [], body: "Thanks for the note." } };
    },
    Output: { object: () => ({}) },
  },
});

process.env.SEER_DATA_DIR = mkdtempSync(path.join(tmpdir(), "seer-tag-strip-"));
process.env.GEMINI_API_KEY = "test-key";
process.env.SEER_GEMINI_MODEL = "gemini-flash-latest";
delete process.env.GOOGLE_GENERATIVE_AI_API_KEY;
delete process.env.AI_GATEWAY_API_KEY;
delete process.env.VERCEL_OIDC_TOKEN;
delete process.env.VERCEL;

const fetchCalls = installFetch();

type AfterContextCtor = new (opts: {
  waitUntil: (promise: Promise<unknown>) => void;
  onClose: (callback: () => void) => void;
  onTaskError: (error: unknown) => void;
}) => unknown;

async function runInRequest<T>(fn: () => Promise<T>): Promise<T> {
  const nextAfter = await import("next/dist/server/after/after-context.js");
  const storage = await import(
    "next/dist/server/app-render/work-async-storage.external.js"
  );
  const AfterContext = nextAfter.AfterContext as AfterContextCtor;
  const tasks: Promise<unknown>[] = [];
  let close: (() => void) | undefined;
  const afterContext = new AfterContext({
    waitUntil(promise) {
      tasks.push(Promise.resolve(promise));
    },
    onClose(callback) {
      close = callback;
    },
    onTaskError(error) {
      console.error(error);
    },
  });
  const result = await storage.workAsyncStorage.run(
    {
      isStaticGeneration: false,
      page: "/api",
      route: "/api",
      afterContext,
      previouslyRevalidatedTags: [],
      refreshTagsByCacheKind: new Map(),
      shouldTrackFetchMetrics: false,
      buildId: "test",
      cacheComponentsEnabled: false,
      dev: true,
      pendingRevalidates: {},
      pendingRevalidateWrites: [],
      pendingRevalidatedTags: [],
      runInCleanSnapshot: (f: (...args: unknown[]) => unknown, ...args: unknown[]) =>
        f(...args),
    },
    fn,
  );
  close?.();
  await Promise.all(tasks);
  return result;
}

function assertFast(label: string, ms: number) {
  assert.ok(
    ms < BUDGET_MS,
    `${label} took ${ms.toFixed(0)}ms; stripping a ${ATTACK_CHARS}-character HTML body must finish in under ${BUDGET_MS}ms`,
  );
}

function assertReadBody(label: string, prompt: string, kind: BodyKind) {
  if (kind === "html-benign") {
    assert.ok(
      prompt.includes("Please review the contract"),
      `${label} did not grade the visible text of the HTML body`,
    );
    return;
  }
  assert.ok(
    prompt.includes("<".repeat(1000)),
    `${label} did not grade the message body`,
  );
}

const failures: string[] = [];

async function check(name: string, fn: () => Promise<void> | void) {
  try {
    await fn();
    console.log(`ok ${name}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    failures.push(`${name}: ${message}`);
    console.error(`FAIL ${name}: ${message}`);
  }
}

async function main() {
  const mailbox = await import("../src/app/api/mailbox/route.ts");
  const today = await import("../src/app/api/today/route.ts");
  const alltasks = await import("../src/app/api/alltasks/route.ts");
  const messageRoute = await import("../src/app/api/messages/[id]/route.ts");
  const draft = await import("../src/app/api/assist/draft/route.ts");
  const send = await import("../src/app/api/send/route.ts");
  const cron = await import("../src/app/api/cron/sync/route.ts");
  const { htmlToText, storedBodyText } = await import(
    "../src/lib/v2/intelligence/html-text.ts"
  );
  const { freshBody } = await import("../src/lib/v3/reader/thread-shape.ts");
  const { messageFromReadRow } = await import(
    "../src/lib/v2/intelligence/load-conversation.ts"
  );
  const { GmailProvider } = await import("../src/lib/v2/providers/gmail.ts");
  const { OutlookProvider } = await import("../src/lib/v2/providers/outlook.ts");
  const { extractKeyActions } = await import("../src/lib/inbox/key-actions.ts");
  const { quoteBody } = await import("../src/lib/v2/client/reply.ts");
  const { kvSet } = await import("../src/lib/store/kv.ts");

  // Anchor extraction only scans <a> elements. A body of bare less-than
  // signs must stay cheap; this guards that separate scanner.
  await check("extractKeyActions", () => {
    const t0 = performance.now();
    const actions = extractKeyActions(ATTACK_HTML, "respond");
    const ms = performance.now() - t0;
    assert.deepEqual(actions, []);
    assertFast("extractKeyActions", ms);
  });

  // quoteBody has no production caller. Kept here so a later caller cannot
  // reintroduce an unbounded scan without this spec failing.
  await check("quoteBody", () => {
    const t0 = performance.now();
    const quoted = quoteBody({
      providerConversationId: THREAD_ID,
      subject: SUBJECT,
      lastMessageAt: new Date().toISOString(),
      messages: [
        {
          providerMessageId: MESSAGE_ID,
          from: { email: "stranger@example.com", name: "Stranger" },
          to: [],
          cc: [],
          sentAt: new Date().toISOString(),
          snippet: "preview",
          bodyHtml: ATTACK_HTML,
          bodyText: null,
          isUnread: true,
          isOutgoing: false,
          attachments: [],
        },
      ],
    });
    assertFast("quoteBody", performance.now() - t0);
    assert.ok(quoted.includes("<"));
  });

  await check("htmlToText attack", () => {
    const t0 = performance.now();
    const text = htmlToText(ATTACK_HTML);
    assertFast("htmlToText", performance.now() - t0);
    assert.ok(text.includes("<".repeat(1000)));
  });

  await check("htmlToText benign", () => {
    const text = htmlToText(BENIGN_HTML);
    assert.ok(text.includes("Please review the contract"), text);
  });

  await check("storedBodyText", () => {
    const t0 = performance.now();
    const text = storedBodyText({ bodyText: null, bodyHtml: ATTACK_HTML });
    assertFast("storedBodyText", performance.now() - t0);
    assert.ok(text?.includes("<".repeat(1000)));
  });

  await check("messageFromReadRow", () => {
    const t0 = performance.now();
    const row = messageFromReadRow({
      provider_message_id: MESSAGE_ID,
      from_email: "stranger@example.com",
      from_name: "Stranger",
      to_emails: ["owner@example.com"],
      cc_emails: [],
      sent_at: new Date().toISOString(),
      body_html: ATTACK_HTML,
      body_text: null,
      snippet: "preview",
      is_unread: true,
      is_outgoing: false,
      attachment_names: [],
    });
    assertFast("messageFromReadRow", performance.now() - t0);
    assert.ok(row?.bodyText?.includes("<".repeat(1000)));
  });

  await check("freshBody", () => {
    const t0 = performance.now();
    const body = freshBody({
      providerMessageId: MESSAGE_ID,
      from: { email: "stranger@example.com", name: "Stranger" },
      to: [],
      cc: [],
      sentAt: new Date().toISOString(),
      snippet: "preview",
      bodyHtml: ATTACK_HTML,
      bodyText: null,
      isUnread: true,
      isOutgoing: false,
      attachments: [],
    });
    assertFast("freshBody", performance.now() - t0);
    assert.ok(body.text.includes("<") || body.html.includes("<"));
  });

  async function providerBody(kind: "gmail" | "outlook") {
    const fetchImpl: typeof fetch = async (input) => {
      const url = String(input);
      if (kind === "gmail" && url.includes("/threads/")) {
        return json({
          id: THREAD_ID,
          messages: [
            {
              id: MESSAGE_ID,
              threadId: THREAD_ID,
              snippet: "preview",
              labelIds: ["INBOX", "UNREAD"],
              internalDate: String(Date.now()),
              payload: {
                mimeType: "text/html",
                headers: [
                  { name: "From", value: FROM },
                  { name: "Subject", value: SUBJECT },
                ],
                body: {
                  data: Buffer.from(ATTACK_HTML, "utf8").toString("base64url"),
                },
              },
            },
          ],
        });
      }
      if (kind === "outlook") {
        return json({
          value: [
            {
              id: MESSAGE_ID,
              conversationId: THREAD_ID,
              subject: SUBJECT,
              bodyPreview: "",
              body: { contentType: "html", content: ATTACK_HTML },
              receivedDateTime: new Date().toISOString(),
              isRead: false,
              from: {
                emailAddress: { address: "stranger@example.com", name: "Stranger" },
              },
            },
          ],
        });
      }
      return json({});
    };
    const convo =
      kind === "gmail"
        ? await new GmailProvider({
            accessToken: "test-token",
            accountEmail: "owner@example.com",
            fetchImpl,
          }).getConversation(THREAD_ID)
        : await new OutlookProvider({
            accessToken: "test-token",
            accountEmail: "owner@example.com",
            fetchImpl,
          }).getConversation(THREAD_ID);
    const message = convo.messages[0];
    assert.equal(message?.bodyText ?? null, null, `${kind} HTML-only bodyText`);
    assert.equal(message?.bodyHtml?.length, ATTACK_CHARS);
    const t0 = performance.now();
    const text = storedBodyText({
      bodyText: message?.bodyText ?? null,
      bodyHtml: message?.bodyHtml ?? null,
    });
    assertFast(`${kind} sync storedBodyText`, performance.now() - t0);
    assert.ok(text?.includes("<".repeat(1000)));
  }

  await check("gmail provider sync strip", () => providerBody("gmail"));
  await check("outlook provider sync strip", () => providerBody("outlook"));

  async function timeMailbox(kind: BodyKind, provider: "google" | "microsoft-entra-id") {
    state.kind = kind;
    session.provider = provider;
    session.email = `owner-${provider}-${kind}@example.com`;
    prompts.length = 0;
    const t0 = performance.now();
    const res = await runInRequest(() =>
      mailbox.GET(new Request("http://localhost/api/mailbox?folder=inbox")),
    );
    const ms = performance.now() - t0;
    const body = (await res.json()) as { error?: string; assistant?: { pending?: number } };
    assert.equal(res.status, 200, body.error ?? "mailbox status");
    assert.ok(prompts.length > 0, "mailbox grading never read a body");
    assertReadBody("mailbox", prompts.join("\n"), kind);
    return ms;
  }

  await check("mailbox text/plain", async () => {
    const plainMs = await timeMailbox("plain-attack", "google");
    assertFast("mailbox text/plain body", plainMs);
  });
  await check("mailbox benign HTML", async () => {
    const benignMs = await timeMailbox("html-benign", "google");
    assertFast("mailbox benign HTML", benignMs);
  });
  await check("mailbox HTML-only", async () => {
    const attackMs = await timeMailbox("html-attack", "google");
    assertFast("GET /api/mailbox HTML-only body", attackMs);
  });
  await check("mailbox Graph HTML-only", async () => {
    const graphMs = await timeMailbox("html-attack", "microsoft-entra-id");
    assertFast("GET /api/mailbox Graph HTML-only body", graphMs);
  });

  async function timeHandler(
    label: string,
    kind: BodyKind,
    run: () => Promise<Response>,
    expectPrompt: boolean,
  ) {
    state.kind = kind;
    session.provider = "google";
    session.email = `owner-${label}-${kind}@example.com`;
    prompts.length = 0;
    const t0 = performance.now();
    const res = await runInRequest(run);
    const ms = performance.now() - t0;
    const body = (await res.json()) as { error?: string };
    assert.equal(res.status, 200, `${label}: ${body.error ?? res.status}`);
    if (expectPrompt) {
      assert.ok(prompts.length > 0, `${label} never read a body`);
      assertReadBody(label, prompts.join("\n"), kind);
    }
    if (kind === "html-attack") assertFast(label, ms);
    return ms;
  }

  await check("today", () =>
    timeHandler("GET /api/today", "html-attack", () => today.GET(), true),
  );
  await check("alltasks", () =>
    timeHandler("GET /api/alltasks", "html-attack", () => alltasks.GET(), true),
  );
  await check("message", () =>
    timeHandler(
      "GET /api/messages/[id]",
      "html-attack",
      () =>
        messageRoute.GET(new Request("http://localhost/api/messages/msg-1"), {
          params: Promise.resolve({ id: MESSAGE_ID }),
        }),
      false,
    ),
  );
  await check("draft", () =>
    timeHandler(
      "POST /api/assist/draft",
      "html-attack",
      () =>
        draft.POST(
          new Request("http://localhost/api/assist/draft", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ id: MESSAGE_ID, intent: "yes" }),
          }),
        ),
      true,
    ),
  );
  await check("send", () =>
    timeHandler(
      "POST /api/send",
      "html-attack",
      () =>
        send.POST(
          new Request("http://localhost/api/send", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              mode: "reply",
              replyToId: MESSAGE_ID,
              body: "Sounds good.",
            }),
          }),
        ),
      false,
    ),
  );

  await check("cron", async () => {
    process.env.SEER_LEGACY_CRON = "on";
    process.env.SEER_V3_LEGACY_ACCOUNT_FALLBACK = "1";
    await kvSet("accounts", {
      accounts: [
        {
          id: "acc-1",
          provider: "google",
          email: "cron-owner@example.com",
          name: "Owner",
          accessToken: "test-token",
          refreshToken: "refresh-placeholder",
          expiresAt: 9_999_999_999,
          updatedAt: new Date().toISOString(),
        },
      ],
    });
    state.kind = "html-attack";
    prompts.length = 0;
    const cronStarted = performance.now();
    const cronRes = await runInRequest(() =>
      cron.GET(new Request("http://localhost/api/cron/sync")),
    );
    const cronMs = performance.now() - cronStarted;
    const cronBody = (await cronRes.json()) as { error?: string; disabled?: string };
    assert.equal(cronRes.status, 200, cronBody.error ?? "cron status");
    assert.equal(cronBody.disabled, undefined);
    assert.ok(prompts.length > 0, "legacy cron never read a body");
    assertReadBody("GET /api/cron/sync", prompts.join("\n"), "html-attack");
    assertFast("GET /api/cron/sync", cronMs);
  });

  assert.ok(fetchCalls.length > 0);
  if (failures.length > 0) {
    throw new Error(`${failures.length} check(s) failed:\n${failures.join("\n")}`);
  }
  console.log("tag-strip checks finished");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
