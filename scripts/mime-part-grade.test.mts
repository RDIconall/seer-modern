/**
 * Spec: grade and deep-read the body the reader actually shows.
 *
 * A multipart/alternative message can carry a text/plain part that says there
 * is nothing to do and a text/html part that asks for a decision. These tests
 * fail while grading still prefers the plain part whenever it is non-empty.
 * They pass once the graded text is the body the open reader displays, and
 * the plain part is used only when that reader is not showing HTML.
 *
 * Run:
 *   node --experimental-test-module-mocks --import tsx scripts/mime-part-grade.test.mts
 *
 * Not covered here (same `textBody || stripped html` choice, different entry):
 *   src/app/api/mailbox/route.ts
 *   src/app/api/today/route.ts
 *   src/app/api/alltasks/route.ts
 *   src/app/api/assist/draft/route.ts
 *   src/app/api/send/route.ts
 * Graph/Outlook is not the same attack: getGraphMessage keeps a single body
 * and does not parse a second MIME part.
 */
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { mock } from "node:test";
import { JSDOM } from "jsdom";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

const dom = new JSDOM("<!doctype html><html><body></body></html>");
globalThis.window = dom.window as unknown as Window & typeof globalThis;
globalThis.document = dom.window.document;
globalThis.HTMLElement = dom.window.HTMLElement;
globalThis.Node = dom.window.Node;
globalThis.Element = dom.window.Element;
globalThis.DOMParser = dom.window.DOMParser;

const DATA_DIR = mkdtempSync(path.join(tmpdir(), "seer-mime-grade-"));
process.env.SEER_DATA_DIR = DATA_DIR;
process.env.SEER_LEGACY_CRON = "on";
process.env.SEER_V3_LEGACY_ACCOUNT_FALLBACK = "1";
process.env.SEER_GEMINI_MODEL = "gemini-flash-latest";
process.env.GEMINI_API_KEY = "test-key";
delete process.env.CRON_SECRET;
delete process.env.OPENAI_API_KEY;
delete process.env.GOOGLE_GENERATIVE_AI_API_KEY;
delete process.env.AI_GATEWAY_API_KEY;
delete process.env.VERCEL_OIDC_TOKEN;
delete process.env.VERCEL;

const PLAIN_DISMISSAL =
  "Your package is on the way and will arrive tomorrow. Nothing else is needed.";
const HTML_ASK =
  "<p>Attempted delivery failed. Signature required. Please pick up the package today.</p>";
const PLAIN_ASK =
  "Attempted delivery failed. Signature required. Please pick up the package today.";
const HTML_QUOTED_DISMISSAL =
  '<p>Your package is on the way and will arrive tomorrow. Nothing else is needed.</p><div class="gmail_quote">On Monday, someone wrote: older note</div>';
const PLAIN_ONLY = "Plain only status update. The package is on the way.";

const prompts: string[] = [];

mock.module("@/lib/mail/session", {
  namedExports: {
    requireMailSession: async () => ({
      email: "owner@example.com",
      accessToken: "test-access-token",
      provider: "google",
    }),
  },
});

mock.module("ai", {
  namedExports: {
    generateText: async (args: { prompt?: unknown }) => {
      prompts.push(
        typeof args.prompt === "string"
          ? args.prompt
          : JSON.stringify(args.prompt ?? ""),
      );
      throw new Error("model stand-in");
    },
    Output: {
      object: () => ({}),
    },
  },
});

const { classifyMessage } = await import("../src/lib/inbox/classify.ts");
const { primaryMailAction } = await import("../src/lib/inbox/types.ts");
const { LegacyThread } = await import("../src/components/mail/LegacyThread.tsx");
const { Reader } = await import("../src/components/v2/Reader.tsx");
const { GET: getMessage } = await import("../src/app/api/messages/[id]/route.ts");
const { GET: cronSync } = await import("../src/app/api/cron/sync/route.ts");
const { GmailProvider } = await import("../src/lib/v2/providers/gmail.ts");
const { syncFolder } = await import("../src/lib/v2/sync/engine.ts");
const { conversationPayload } = await import("../src/lib/v2/intelligence/model.ts");
const { loadConversation } = await import("../src/lib/v2/intelligence/load-conversation.ts");
const { getCorpusConversation } = await import("../src/lib/v3/reader/repository.ts");
const { upsertUser, upsertAccount } = await import("../src/lib/v2/db/accounts.ts");
const { startTestDb } = await import("./v2-testdb.mts");
const { promises: fs } = await import("node:fs");

function b64url(text: string): string {
  return Buffer.from(text, "utf8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function gmailFullMessage(opts: {
  id: string;
  threadId: string;
  plain: string | null;
  html: string | null;
}) {
  const parts = [];
  if (opts.plain !== null) {
    parts.push({
      mimeType: "text/plain",
      body: { size: opts.plain.length, data: b64url(opts.plain) },
    });
  }
  if (opts.html !== null) {
    parts.push({
      mimeType: "text/html",
      body: { size: opts.html.length, data: b64url(opts.html) },
    });
  }
  return {
    id: opts.id,
    threadId: opts.threadId,
    snippet: "Delivery update",
    labelIds: ["INBOX", "UNREAD"],
    internalDate: String(Date.now()),
    payload: {
      mimeType: "multipart/alternative",
      headers: [
        { name: "From", value: "UPS Tracking <tracking@ups.com>" },
        { name: "To", value: "Owner <owner@example.com>" },
        { name: "Subject", value: "Delivery update" },
        { name: "Message-ID", value: `<${opts.id}@example.test>` },
      ],
      parts,
    },
  };
}

const DANGER = gmailFullMessage({
  id: "msg-danger",
  threadId: "thr-danger",
  plain: PLAIN_DISMISSAL,
  html: HTML_ASK,
});
const INVERSE = gmailFullMessage({
  id: "msg-inverse",
  threadId: "thr-inverse",
  plain: PLAIN_ASK,
  html: HTML_QUOTED_DISMISSAL,
});
const PLAIN = gmailFullMessage({
  id: "msg-plain",
  threadId: "thr-plain",
  plain: PLAIN_ONLY,
  html: null,
});

const BY_ID: Record<string, ReturnType<typeof gmailFullMessage>> = {
  "msg-danger": DANGER,
  "msg-inverse": INVERSE,
  "msg-plain": PLAIN,
};
const BY_THREAD: Record<string, ReturnType<typeof gmailFullMessage>> = {
  "thr-danger": DANGER,
  "thr-inverse": INVERSE,
  "thr-plain": PLAIN,
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function installFetch() {
  const previous = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    const host = new URL(url).host;
    if (
      host !== "gmail.googleapis.com" &&
      host !== "people.googleapis.com" &&
      host !== "www.googleapis.com"
    ) {
      throw new Error(`refusing unexpected network request to ${host}`);
    }
    if (host !== "gmail.googleapis.com") {
      return new Response("", { status: 403 });
    }
    const method = (init?.method ?? "GET").toUpperCase();
    if (method !== "GET") return jsonResponse({});

    const full = url.match(/\/messages\/([^/?]+)\?format=full/);
    if (full) {
      const message = BY_ID[decodeURIComponent(full[1])];
      if (!message) return new Response("missing", { status: 404 });
      return jsonResponse(message);
    }
    const metadata = url.match(/\/messages\/([^/?]+)\?format=metadata/);
    if (metadata) {
      const message = BY_ID[decodeURIComponent(metadata[1])];
      if (!message) return new Response("missing", { status: 404 });
      return jsonResponse({
        id: message.id,
        threadId: message.threadId,
        snippet: message.snippet,
        labelIds: message.labelIds,
        internalDate: message.internalDate,
        payload: { headers: message.payload.headers },
      });
    }
    if (url.includes("/messages?")) {
      const q = new URL(url).searchParams.get("q") ?? "";
      if (q.includes("in:inbox")) {
        return jsonResponse({
          messages: [DANGER, INVERSE, PLAIN].map((m) => ({
            id: m.id,
            threadId: m.threadId,
          })),
        });
      }
      return jsonResponse({ messages: [] });
    }
    const thread = url.match(/\/threads\/([^/?]+)/);
    if (thread) {
      const message = BY_THREAD[decodeURIComponent(thread[1])];
      if (!message) return new Response("missing", { status: 404 });
      if (url.includes("format=minimal")) {
        return jsonResponse({ messages: [{ id: message.id }] });
      }
      if (url.includes("format=metadata")) {
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
      return jsonResponse({
        id: message.threadId,
        messages: [message],
      });
    }
    if (url.includes("/labels/INBOX")) {
      return jsonResponse({ messagesTotal: 3, threadsTotal: 3 });
    }
    if (url.includes("/labels")) return jsonResponse({ labels: [] });
    return jsonResponse({});
  }) as typeof fetch;
  return () => {
    globalThis.fetch = previous;
  };
}

function bodiesFor(id: string): string[] {
  const found: string[] = [];
  for (const prompt of prompts) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(prompt);
    } catch {
      continue;
    }
    const items = Array.isArray(parsed)
      ? parsed
      : parsed && typeof parsed === "object" && "emails" in parsed
        ? (parsed as { emails?: unknown[] }).emails ?? []
        : [];
    for (const item of items) {
      if (!item || typeof item !== "object") continue;
      const row = item as { id?: string; body?: string; snippet?: string };
      if (row.id !== id) continue;
      found.push(row.body ?? row.snippet ?? "");
    }
  }
  return found;
}

function legacyMarkup(json: {
  message: {
    htmlBody: string;
    textBody: string;
    subject: string;
    fromName: string;
    fromEmail: string;
    toEmail?: string;
    ccEmail?: string;
    threadId: string;
    messageIdHeader?: string;
    receivedAt: string;
  };
  thread: {
    id: string;
    htmlBody: string;
    textBody: string;
    fromName: string;
    fromEmail: string;
    receivedAt?: string;
  }[];
}): string {
  return renderToStaticMarkup(
    createElement(LegacyThread, {
      reader: {
        htmlBody: json.message.htmlBody,
        textBody: json.message.textBody,
        subject: json.message.subject,
        fromName: json.message.fromName,
        fromEmail: json.message.fromEmail,
        toEmail: json.message.toEmail ?? "",
        ccEmail: json.message.ccEmail ?? "",
        threadId: json.message.threadId,
        messageIdHeader: json.message.messageIdHeader ?? "",
        receivedAt: json.message.receivedAt,
        thread: json.thread,
      },
    }),
  );
}

let failures = 0;
async function check(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    console.log(`  ok   ${name}`);
  } catch (error) {
    failures += 1;
    console.error(
      `  FAIL ${name}\n       ${error instanceof Error ? error.message : error}`,
    );
  }
}

console.log("mime part grade");

await check(
  "the two parts grade differently when each is the text being judged",
  async () => {
    const dismissal = classifyMessage(
      {
        fromEmail: "tracking@ups.com",
        fromName: "UPS Tracking",
        subject: "Delivery update",
        snippet: PLAIN_DISMISSAL,
      },
      null,
      null,
    );
    const ask = classifyMessage(
      {
        fromEmail: "tracking@ups.com",
        fromName: "UPS Tracking",
        subject: "Delivery update",
        snippet: PLAIN_ASK,
      },
      null,
      null,
    );
    assert.equal(dismissal.action, "delete_now");
    assert.equal(dismissal.debug.ruleId, "shipper-status-delete");
    assert.equal(primaryMailAction(dismissal.action), "trash");
    assert.equal(ask.action, "act_today");
    assert.equal(ask.debug.ruleId, "shipper-needs-you");
  },
);

const restoreFetch = installFetch();

await check(
  "opening a message grades the HTML the legacy thread shows",
  async () => {
    const res = await getMessage(new Request("http://localhost/api/messages/msg-danger"), {
      params: Promise.resolve({ id: "msg-danger" }),
    });
    const json = (await res.json()) as {
      classification: { action: string; debug: { ruleId: string } };
      message: Parameters<typeof legacyMarkup>[0]["message"];
      thread: Parameters<typeof legacyMarkup>[0]["thread"];
    };
    assert.equal(res.status, 200, JSON.stringify(json));
    const shown = legacyMarkup(json);
    assert.match(shown, /Signature required/);
    assert.doesNotMatch(shown, /Nothing else is needed/);
    assert.equal(json.classification.action, "act_today");
    assert.match(json.classification.debug.ruleId, /shipper-needs-you/);
    assert.equal(primaryMailAction(json.classification.action), "read");
  },
);

await check(
  "opening a message whose HTML is hidden as a quote grades the plain text on screen",
  async () => {
    const res = await getMessage(new Request("http://localhost/api/messages/msg-inverse"), {
      params: Promise.resolve({ id: "msg-inverse" }),
    });
    const json = (await res.json()) as {
      classification: { action: string };
      message: Parameters<typeof legacyMarkup>[0]["message"];
      thread: Parameters<typeof legacyMarkup>[0]["thread"];
    };
    assert.equal(res.status, 200, JSON.stringify(json));
    const shown = legacyMarkup(json);
    assert.match(shown, /Signature required/);
    assert.doesNotMatch(shown, /Nothing else is needed/);
    assert.equal(json.classification.action, "act_today");
    assert.equal(primaryMailAction(json.classification.action), "read");
  },
);

await check(
  "a message with no HTML part is still graded from its plain text",
  async () => {
    const res = await getMessage(new Request("http://localhost/api/messages/msg-plain"), {
      params: Promise.resolve({ id: "msg-plain" }),
    });
    const json = (await res.json()) as {
      classification: { action: string; debug: { ruleId: string } };
    };
    assert.equal(res.status, 200, JSON.stringify(json));
    assert.equal(json.classification.action, "delete_now");
    assert.match(json.classification.debug.ruleId, /shipper-status-delete/);
  },
);

await check(
  "legacy deep read submits the body the legacy thread would show",
  async () => {
    const accountsPath = path.join(DATA_DIR, "accounts.json");
    await fs.writeFile(
      accountsPath,
      JSON.stringify({
        accounts: [
          {
            id: "acct-1",
            provider: "google",
            email: "owner@example.com",
            name: "Owner",
            accessToken: "test-access-token",
            refreshToken: "test-refresh-token",
            expiresAt: Math.floor(Date.now() / 1000) + 86_400,
            updatedAt: new Date().toISOString(),
          },
        ],
      }),
    );
    prompts.length = 0;
    const res = await cronSync(new Request("http://localhost/api/cron/sync"));
    const report = await res.json();
    assert.equal(res.status, 200, JSON.stringify(report));
    const danger = bodiesFor("msg-danger");
    const inverse = bodiesFor("msg-inverse");
    const plain = bodiesFor("msg-plain");
    assert.ok(danger.length > 0, "deep read never sent the dangerous message");
    assert.ok(inverse.length > 0, "deep read never sent the quoted message");
    assert.ok(plain.length > 0, "deep read never sent the plain-only message");
    for (const body of danger) {
      assert.match(body, /Signature required/);
      assert.doesNotMatch(body, /Nothing else is needed/);
    }
    for (const body of inverse) {
      assert.match(body, /Signature required/);
      assert.doesNotMatch(body, /Nothing else is needed/);
    }
    for (const body of plain) {
      assert.match(body, /Plain only status update/);
    }
  },
);

restoreFetch();

await check(
  "the live sync deep-read grades the text the v3 reader shows",
  async () => {
    const db = await startTestDb();
    try {
      const userId = await upsertUser("owner@example.com");
      const accountId = await upsertAccount({
        userId,
        provider: "google",
        email: "owner@example.com",
      });
      const provider = new GmailProvider({
        accessToken: "test-access-token",
        accountEmail: "owner@example.com",
        fetchImpl: async (input) => {
          const url = String(input);
          if (url.includes("/threads?") && url.includes("in%3Ainbox")) {
            return jsonResponse({
              threads: [
                { id: "thr-danger" },
                { id: "thr-inverse" },
                { id: "thr-plain" },
              ],
              resultSizeEstimate: 3,
            });
          }
          const thread = url.match(/\/threads\/([^?]+)\?format=full/);
          if (thread) {
            const message = BY_THREAD[decodeURIComponent(thread[1])];
            if (!message) return new Response("missing", { status: 404 });
            return jsonResponse({ id: message.threadId, messages: [message] });
          }
          throw new Error(`unexpected provider request ${url}`);
        },
      });
      await syncFolder(accountId, provider, "inbox", "incremental", { maxPages: 1 });
      const stored = await db.pool.query<{
        id: string;
        provider_conversation_id: string;
      }>(
        `select id, provider_conversation_id
           from seer.conversations
          where account_id = $1`,
        [accountId],
      );
      assert.equal(stored.rowCount, 3);

      const problems: string[] = [];
      for (const row of stored.rows) {
        const read = await loadConversation(row.id);
        const ui = await getCorpusConversation(accountId, row.id, "google");
        assert.ok(read);
        assert.ok(ui);
        const graded = conversationPayload(read).messages[0]?.body ?? "";
        const markup = renderToStaticMarkup(
          createElement(Reader, {
            provider: "google",
            conversation: ui.conversation,
            ownEmail: "owner@example.com",
            onReply: () => {},
            onReplyAll: () => {},
            onForward: () => {},
            onArchive: () => {},
            onDelete: () => {},
          }),
        );
        const expectShown = (label: string, pattern: RegExp, absent: RegExp) => {
          if (!pattern.test(markup) || absent.test(markup)) {
            problems.push(`${label} reader markup did not show only the visible part`);
          }
          if (!pattern.test(graded) || absent.test(graded)) {
            problems.push(
              `${label} graded body was ${JSON.stringify(graded)}`,
            );
          }
        };
        if (row.provider_conversation_id === "thr-danger") {
          expectShown("danger", /Signature required/, /Nothing else is needed/);
        } else if (row.provider_conversation_id === "thr-inverse") {
          expectShown("inverse", /Nothing else is needed/, /Signature required/);
        } else if (row.provider_conversation_id === "thr-plain") {
          if (!/Plain only status update/.test(markup) || !/Plain only status update/.test(graded)) {
            problems.push(`plain graded body was ${JSON.stringify(graded)}`);
          }
        } else {
          problems.push(`unexpected conversation ${row.provider_conversation_id}`);
        }
      }
      assert.deepEqual(problems, []);
    } finally {
      await db.stop();
    }
  },
);

if (failures > 0) {
  console.error(`mime-part-grade: ${failures} failed`);
  process.exit(1);
}
console.log("mime-part-grade: OK");
