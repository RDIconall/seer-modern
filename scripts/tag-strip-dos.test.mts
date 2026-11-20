/**
 * Spec for the HTML tag-strip denial of service.
 *
 * These assertions fail while a nested-quantifier tag match still runs on the
 * full attacker-controlled body, and they pass once that scan is bounded
 * (a hard byte cap, then a linear strip) on every path below.
 *
 * Run: npx tsx scripts/tag-strip-dos.test.mts
 */
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { freshBody } from "../src/lib/v3/reader/thread-shape.ts";
import { htmlToText, storedBodyText } from "../src/lib/v2/intelligence/html-text.ts";
import { quoteBody } from "../src/lib/v2/client/reply.ts";
import { GmailProvider } from "../src/lib/v2/providers/gmail.ts";
import { OutlookProvider } from "../src/lib/v2/providers/outlook.ts";
import type { Conversation, Message } from "../src/lib/v2/providers/types.ts";

const SMALL = 20_000;
const LARGE = 40_000;
/**
 * A 40k less-than run is about a second with the nested tag match, and about
 * four times that at 80k. A byte cap before a linear scan stays under this.
 */
const STALL_MS = 400;

const failures: string[] = [];

function check(condition: unknown, message: string): void {
  if (!condition) failures.push(message);
}

function lessThans(n: number): string {
  return "<".repeat(n);
}

function elapsed(run: () => void): number {
  const started = performance.now();
  run();
  return performance.now() - started;
}

function assertSubquadratic(label: string, smallMs: number, largeMs: number): void {
  const bound = smallMs * 2.5 + 40;
  check(
    largeMs < bound,
    `${label}: doubling a less-than run from ${SMALL} to ${LARGE} took ${smallMs.toFixed(0)}ms then ${largeMs.toFixed(0)}ms (bound ${bound.toFixed(0)}ms). The tag match rescans the tail at every '<'.`,
  );
}

function message(html: string | null, text: string | null = null): Message {
  return {
    providerMessageId: "m1",
    from: { email: "attacker@outside.example", name: "Attacker" },
    to: [{ email: "victim@example.com", name: "Victim" }],
    cc: [],
    sentAt: "2026-11-20T00:00:00.000Z",
    snippet: "note",
    bodyHtml: html,
    bodyText: text,
    isUnread: true,
    isOutgoing: false,
    attachments: [],
  };
}

function conversation(body: Message): Conversation {
  return {
    providerConversationId: "c1",
    subject: "note",
    messages: [body],
    lastMessageAt: body.sentAt,
  };
}

function b64url(value: string): string {
  return Buffer.from(value, "utf8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

// --- htmlToText: v2 sync persistence and the reader both call this on the
// full HTML part before any length cut. ---
{
  const smallMs = elapsed(() => {
    htmlToText(lessThans(SMALL));
  });
  const largeMs = elapsed(() => {
    htmlToText(lessThans(LARGE));
  });
  assertSubquadratic("htmlToText", smallMs, largeMs);
}

// --- freshBody: readableHtml's tag match, then htmlToText, on the full part. ---
{
  const smallMs = elapsed(() => {
    freshBody(message(lessThans(SMALL)));
  });
  const largeMs = elapsed(() => {
    freshBody(message(lessThans(LARGE)));
  });
  assertSubquadratic("freshBody", smallMs, largeMs);
}

// --- quoteBody keeps its own copy of the tag match, with no cap. ---
{
  const ms = elapsed(() => {
    quoteBody(conversation(message(lessThans(LARGE))));
  });
  check(
    ms < STALL_MS,
    `quoteBody stalled ${ms.toFixed(0)}ms on a ${LARGE}-character HTML-only body`,
  );
}

// --- Live Gmail sync: format=full bytes are decoded and only then stripped. ---
{
  const html = lessThans(LARGE);
  const provider = new GmailProvider({
    accessToken: "token-gmail",
    accountEmail: "victim@example.com",
    fetchImpl: async (input) => {
      const url = String(input);
      if (url.includes("/threads?") && !url.includes("/threads/")) {
        return jsonResponse({ threads: [{ id: "t1" }], resultSizeEstimate: 1 });
      }
      if (url.includes("/threads/t1")) {
        return jsonResponse({
          id: "t1",
          messages: [
            {
              id: "m1",
              threadId: "t1",
              snippet: "note",
              internalDate: "1763600000000",
              labelIds: ["INBOX", "UNREAD"],
              payload: {
                mimeType: "text/html",
                headers: [
                  { name: "From", value: "Attacker <attacker@outside.example>" },
                  { name: "To", value: "victim@example.com" },
                  { name: "Subject", value: "note" },
                ],
                body: { data: b64url(html), size: html.length },
              },
            },
          ],
        });
      }
      return jsonResponse({});
    },
  });
  const page = await provider.syncFolder("inbox");
  const synced = page.conversations[0]?.messages[0];
  check(synced, "Gmail sync did not return the attacker message");
  check(
    synced?.bodyText == null && (synced?.bodyHtml?.length ?? 0) >= LARGE,
    `Gmail sync dropped or shortened the HTML-only body (text=${synced?.bodyText?.length ?? "null"} html=${synced?.bodyHtml?.length ?? 0})`,
  );
  if (synced) {
    const ms = elapsed(() => {
      storedBodyText(synced);
    });
    check(
      ms < STALL_MS,
      `storedBodyText after Gmail sync stalled ${ms.toFixed(0)}ms on the decoded HTML-only body`,
    );
  }
}

// --- Live Outlook sync: HTML messages are stored with a null text part, so
// the strip always runs on body.content. ---
{
  const html = lessThans(LARGE);
  const provider = new OutlookProvider({
    accessToken: "token-outlook",
    accountEmail: "victim@example.com",
    fetchImpl: async (input) => {
      const url = String(input);
      if (url.includes("/mailFolders/inbox/messages")) {
        return jsonResponse({
          value: [
            {
              id: "m1",
              conversationId: "c1",
              subject: "note",
              from: {
                emailAddress: {
                  address: "attacker@outside.example",
                  name: "Attacker",
                },
              },
              toRecipients: [{ emailAddress: { address: "victim@example.com" } }],
              receivedDateTime: "2026-11-20T00:00:00.000Z",
              bodyPreview: "note",
              isRead: false,
            },
          ],
        });
      }
      if (url.includes("conversationId")) {
        return jsonResponse({
          value: [
            {
              id: "m1",
              conversationId: "c1",
              subject: "note",
              from: {
                emailAddress: {
                  address: "attacker@outside.example",
                  name: "Attacker",
                },
              },
              toRecipients: [{ emailAddress: { address: "victim@example.com" } }],
              receivedDateTime: "2026-11-20T00:00:00.000Z",
              bodyPreview: "note",
              isRead: false,
              body: { contentType: "html", content: html },
            },
          ],
        });
      }
      if (url.includes("/mailFolders/inbox")) {
        return jsonResponse({ totalItemCount: 1 });
      }
      return jsonResponse({});
    },
  });
  const page = await provider.syncFolder("inbox");
  const synced = page.conversations[0]?.messages[0];
  check(synced, "Outlook sync did not return the attacker message");
  check(
    synced?.bodyText == null && (synced?.bodyHtml?.length ?? 0) >= LARGE,
    `Outlook sync dropped the HTML body (text=${String(synced?.bodyText)} html=${synced?.bodyHtml?.length ?? 0})`,
  );
  if (synced) {
    const ms = elapsed(() => {
      storedBodyText(synced);
    });
    check(
      ms < STALL_MS,
      `storedBodyText after Outlook sync stalled ${ms.toFixed(0)}ms on the HTML body`,
    );
  }
}

// --- Legacy cron: grade and deep-read each download the HTML-only message
// and strip it before any length cut. The next mailbox must not wait on that. ---
{
  const dataDir = await mkdtemp(path.join(tmpdir(), "seer-tag-strip-"));
  const previousFetch = globalThis.fetch;
  const previousEnv = {
    SEER_DATA_DIR: process.env.SEER_DATA_DIR,
    SEER_LEGACY_CRON: process.env.SEER_LEGACY_CRON,
    SEER_V3_LEGACY_ACCOUNT_FALLBACK: process.env.SEER_V3_LEGACY_ACCOUNT_FALLBACK,
    GEMINI_API_KEY: process.env.GEMINI_API_KEY,
    SEER_GEMINI_MODEL: process.env.SEER_GEMINI_MODEL,
    CRON_SECRET: process.env.CRON_SECRET,
  };
  process.env.SEER_DATA_DIR = dataDir;
  process.env.GEMINI_API_KEY = "placeholder";
  process.env.SEER_GEMINI_MODEL = "gemini-flash-latest";
  delete process.env.CRON_SECRET;

  const hostileHtml = lessThans(SMALL);
  let armedAt = 0;
  const stalls: number[] = [];
  let hostileFullFetches = 0;
  const seenUrls: string[] = [];

  const noteStart = () => {
    if (!armedAt) return;
    stalls.push(performance.now() - armedAt);
    armedAt = 0;
  };

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    noteStart();
    const url = String(input);
    seenUrls.push(url.split("?")[0].slice(0, 180));
    const auth = new Headers(init?.headers).get("authorization") ?? "";
    const victim = auth.includes("token-victim");

    if (url.includes("format=full")) {
      const hostile = url.includes("/messages/msg-hostile");
      if (hostile) {
        hostileFullFetches += 1;
        armedAt = performance.now();
        return jsonResponse({
          id: "msg-hostile",
          threadId: "thr-hostile",
          snippet: "note",
          internalDate: "1763600000000",
          labelIds: ["INBOX", "UNREAD"],
          payload: {
            mimeType: "text/html",
            headers: [
              { name: "From", value: "Attacker <attacker@outside.example>" },
              { name: "To", value: "victim@example.com" },
              { name: "Subject", value: "note" },
            ],
            body: { data: b64url(hostileHtml), size: hostileHtml.length },
          },
        });
      }
      return jsonResponse({
        id: "msg-later",
        threadId: "thr-later",
        snippet: "hello",
        internalDate: "1763600001000",
        labelIds: ["INBOX", "UNREAD"],
        payload: {
          mimeType: "text/plain",
          headers: [
            { name: "From", value: "Friend <friend@outside.example>" },
            { name: "To", value: "later@example.com" },
            { name: "Subject", value: "hello" },
          ],
          body: { data: b64url("hello from a person"), size: 19 },
        },
      });
    }

    if (url.includes("gmail.googleapis.com")) {
      if (url.includes("/messages?")) {
        const inbox = url.includes("in%3Ainbox") || url.includes("in:inbox");
        if (!inbox) return jsonResponse({ messages: [] });
        return jsonResponse({
          messages: victim
            ? [{ id: "msg-hostile", threadId: "thr-hostile" }]
            : [{ id: "msg-later", threadId: "thr-later" }],
        });
      }
      if (url.includes("format=metadata") && url.includes("/messages/")) {
        const id = url.includes("msg-hostile") ? "msg-hostile" : "msg-later";
        const threadId = id === "msg-hostile" ? "thr-hostile" : "thr-later";
        const from = id === "msg-hostile"
          ? "Attacker <attacker@outside.example>"
          : "Friend <friend@outside.example>";
        return jsonResponse({
          id,
          threadId,
          snippet: id === "msg-hostile" ? "note" : "hello",
          internalDate: "1763600000000",
          labelIds: ["INBOX", "UNREAD"],
          payload: {
            headers: [
              { name: "From", value: from },
              { name: "To", value: victim ? "victim@example.com" : "later@example.com" },
              { name: "Subject", value: id === "msg-hostile" ? "note" : "hello" },
            ],
          },
        });
      }
      if (url.includes("/labels/INBOX")) {
        return jsonResponse({ messagesTotal: 1, threadsTotal: 1 });
      }
      if (url.includes("/labels")) return jsonResponse({ labels: [] });
      if (url.includes("/threads/")) {
        return jsonResponse({
          messages: [
            {
              id: "msg-turn",
              internalDate: "1763600000000",
              labelIds: ["INBOX"],
              payload: {
                headers: [{ name: "From", value: "Attacker <attacker@outside.example>" }],
              },
            },
          ],
        });
      }
      return jsonResponse({});
    }

    if (url.includes("people.googleapis.com")) {
      return jsonResponse({ connections: [], otherContacts: [] });
    }
    if (url.includes("calendar")) return jsonResponse({ items: [] });
    return jsonResponse({ error: { message: "rejected" } }, 401);
  }) as typeof fetch;

  try {
    await writeFile(
      path.join(dataDir, "accounts.json"),
      JSON.stringify({
        accounts: [
          {
            id: "acct-victim",
            provider: "google",
            email: "victim@example.com",
            name: "Victim",
            accessToken: "token-victim",
            refreshToken: "refresh-victim",
            expiresAt: Math.floor(Date.now() / 1000) + 60 * 60,
            updatedAt: "2026-11-20T00:00:00.000Z",
          },
          {
            id: "acct-later",
            provider: "google",
            email: "later@example.com",
            name: "Later",
            accessToken: "token-later",
            refreshToken: "refresh-later",
            expiresAt: Math.floor(Date.now() / 1000) + 60 * 60,
            updatedAt: "2026-11-20T00:00:00.000Z",
          },
        ],
      }),
    );

    const { GET } = await import("../src/app/api/cron/sync/route.ts");

    process.env.SEER_LEGACY_CRON = "off";
    delete process.env.SEER_V3_LEGACY_ACCOUNT_FALLBACK;
    hostileFullFetches = 0;
    const disabled = await GET(new Request("http://localhost/api/cron/sync"));
    const disabledBody = (await disabled.json()) as { disabled?: string };
    check(
      disabled.status === 200 && disabledBody.disabled === "legacy cron retired",
      `legacy cron should stay retired without SEER_LEGACY_CRON=on (${disabled.status} ${JSON.stringify(disabledBody)})`,
    );
    check(
      hostileFullFetches === 0,
      "retired legacy cron still downloaded a message body",
    );

    process.env.SEER_LEGACY_CRON = "on";
    delete process.env.SEER_V3_LEGACY_ACCOUNT_FALLBACK;
    hostileFullFetches = 0;
    let threw = false;
    try {
      await GET(new Request("http://localhost/api/cron/sync"));
    } catch (error) {
      threw = true;
      check(
        error instanceof Error && /legacy account store is disabled/.test(error.message),
        `SEER_LEGACY_CRON=on without the account fallback failed differently: ${error instanceof Error ? error.message : error}`,
      );
    }
    check(threw, "legacy cron processed mail without the account-store fallback");
    check(
      hostileFullFetches === 0,
      "account-store gate still downloaded a message body",
    );

    process.env.SEER_V3_LEGACY_ACCOUNT_FALLBACK = "1";
    hostileFullFetches = 0;
    stalls.length = 0;
    const response = await Promise.race([
      GET(new Request("http://localhost/api/cron/sync")),
      new Promise<Response>((_, reject) => {
        setTimeout(() => reject(new Error("legacy sync tick hung")), 25_000);
      }),
    ]);
    const report = (await response.json()) as {
      report?: { email?: string; skipped?: string; error?: string }[];
    };
    check(
      hostileFullFetches >= 2,
      `grade and deep-read should each download the HTML-only message (full fetches=${hostileFullFetches}, stalls=${stalls.map((n) => n.toFixed(0)).join(",")})`,
    );
    stalls.forEach((ms, index) => {
      check(
        ms < STALL_MS,
        `legacy sync tag strip #${index + 1} stalled the tick for ${ms.toFixed(0)}ms`,
      );
    });
    const later = report.report?.find((row) => row.email === "later@example.com");
    check(
      later != null && later.skipped !== "time budget",
      `later mailbox was not synced after the hostile message (${JSON.stringify(report.report)})`,
    );
  } finally {
    globalThis.fetch = previousFetch;
    for (const [key, value] of Object.entries(previousEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(dataDir, { recursive: true, force: true });
  }
}

if (failures.length > 0) {
  assert.fail(`\n${failures.join("\n")}`);
}
