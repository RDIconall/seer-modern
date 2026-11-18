/**
 * An out-of-range numeric character reference in a message body must not take
 * the mail client down, and must not make sync or the read job fail the thread.
 *
 * These tests fail while `htmlToText` decodes every numeric reference with
 * `String.fromCodePoint`. They pass once a reference is decoded only for a
 * Unicode scalar (0 to 0x10FFFF, excluding surrogates) and every other value
 * is left as text or replaced, without throwing.
 *
 * Run: npx tsx scripts/numeric-character-reference.test.mts
 */
import assert from "node:assert/strict";
import { createElement } from "react";
import { ErrorBoundaryHandler } from "next/dist/client/components/error-boundary.js";
import {
  htmlToText,
  readableBody,
  storedBodyText,
} from "../src/lib/v2/intelligence/html-text.ts";
import { messageFromReadRow } from "../src/lib/v2/intelligence/load-conversation.ts";
import { conversationPayload } from "../src/lib/v2/intelligence/model.ts";
import { conversationsNeedingRead } from "../src/lib/v2/intelligence/queue.ts";
import { loadConversation } from "../src/lib/v2/intelligence/load-conversation.ts";
import { GmailProvider } from "../src/lib/v2/providers/gmail.ts";
import type { Conversation, Message } from "../src/lib/v2/providers/types.ts";
import { upsertAccount, upsertUser } from "../src/lib/v2/db/accounts.ts";
import { syncAccount } from "../src/lib/v2/sync/engine.ts";
import { getCorpusConversation } from "../src/lib/v3/reader/repository.ts";
import { freshBody, shapeThread } from "../src/lib/v3/reader/thread-shape.ts";
import { startTestDb, type TestDb } from "./v2-testdb.mts";
import * as errorModule from "../src/app/error.tsx";

const VICTIM = "victim@company.example";
const ATTACKER = "attacker@evil.example";
const PLAIN = "The board packet closes on the 22nd.";
const DECIMAL_HTML = `<p>${PLAIN} &#1114112;</p>`;
const HEX_HTML = "<p>Invoice &#x110000; is attached.</p>";
const SURROGATE_HTML = "<p>Status &#xD800; unchanged.</p>";

const failures: string[] = [];

async function check(name: string, fn: () => Promise<void> | void): Promise<void> {
  try {
    await fn();
    console.log(`ok  ${name}`);
  } catch (error) {
    const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
    failures.push(`${name}\n${message}`);
    console.error(`FAIL ${name}\n${message}`);
  }
}

function componentOf(module: unknown): React.ComponentType<{
  error: Error & { digest?: string };
  reset: () => void;
}> {
  let candidate = module as { default?: unknown };
  while (candidate && typeof candidate !== "function" && "default" in candidate) {
    candidate = candidate.default as { default?: unknown };
  }
  assert.equal(typeof candidate, "function");
  return candidate as React.ComponentType<{
    error: Error & { digest?: string };
    reset: () => void;
  }>;
}

const AppError = componentOf(errorModule);

/** No lone surrogate, and the words around the reference are still there. */
function assertSafeReading(actual: string, parts: string[]): void {
  assert.equal(typeof actual, "string");
  for (const part of parts) {
    assert.ok(actual.includes(part), `${JSON.stringify(actual)} should include ${JSON.stringify(part)}`);
  }
  for (const char of actual) {
    const code = char.codePointAt(0) ?? 0;
    assert.ok(
      code < 0xd800 || code > 0xdfff,
      `decoded text contains a surrogate ${code.toString(16)}: ${JSON.stringify(actual)}`,
    );
  }
}

function message(over: Partial<Message>): Message {
  return {
    providerMessageId: "m1",
    from: { email: ATTACKER, name: "Outside Sender" },
    to: [{ email: VICTIM, name: "Victim" }],
    cc: [],
    sentAt: "2026-08-04T09:00:00.000Z",
    snippet: PLAIN,
    bodyHtml: DECIMAL_HTML,
    bodyText: PLAIN,
    isUnread: true,
    isOutgoing: false,
    attachments: [],
    ...over,
  };
}

function conversation(messages: Message[], subject = "Board packet"): Conversation {
  return {
    providerConversationId: "thread-1",
    subject,
    messages,
    lastMessageAt: messages[messages.length - 1]?.sentAt ?? "",
  };
}

function b64url(value: string): string {
  return Buffer.from(value, "utf8").toString("base64url");
}

function gmailMessage(input: {
  id: string;
  threadId: string;
  subject: string;
  html: string;
  text?: string;
}): unknown {
  const headers = [
    { name: "From", value: `Outside Sender <${ATTACKER}>` },
    { name: "To", value: VICTIM },
    { name: "Subject", value: input.subject },
  ];
  const payload = input.text
    ? {
        mimeType: "multipart/alternative",
        headers,
        parts: [
          { mimeType: "text/plain", body: { size: input.text.length, data: b64url(input.text) } },
          { mimeType: "text/html", body: { size: input.html.length, data: b64url(input.html) } },
        ],
      }
    : {
        mimeType: "text/html",
        headers,
        body: { size: input.html.length, data: b64url(input.html) },
      };
  return {
    id: input.id,
    threadId: input.threadId,
    snippet: input.subject,
    labelIds: ["INBOX", "UNREAD"],
    internalDate: String(Date.parse("2026-08-04T09:00:00.000Z")),
    payload,
  };
}

await check("valid numeric references still decode", () => {
  assert.equal(htmlToText("<p>Fee &#8212; $5</p>"), "Fee — $5");
  assert.equal(htmlToText("<p>OK &#128512;</p>"), "OK 😀");
  assert.equal(htmlToText("<p>End &#x10FFFF;</p>"), "End 􏿿");
  assert.equal(htmlToText("<p>IgG &gt; 15</p>"), "IgG > 15");
});

await check("decimal reference above U+10FFFF does not throw", () => {
  assertSafeReading(htmlToText(DECIMAL_HTML), [PLAIN]);
  assertSafeReading(
    htmlToText("<p>Fee &#8212; &#1114112; due</p>"),
    ["Fee —", "due"],
  );
});

await check("hex reference above U+10FFFF does not throw", () => {
  assertSafeReading(htmlToText(HEX_HTML), ["Invoice", "is attached"]);
  assertSafeReading(htmlToText("<p>Fee &#X110000; due</p>"), ["Fee", "due"]);
});

await check("hex surrogate is not decoded into a lone surrogate", () => {
  assertSafeReading(htmlToText(SURROGATE_HTML), ["Status", "unchanged"]);
  assertSafeReading(htmlToText("<p>A &#xdfff; B</p>"), ["A", "B"]);
});

await check("multipart body keeps its text and still renders the HTML part", () => {
  const poisoned = message({});
  // A text part skips HTML decoding on the write helper. The reader does not.
  assert.equal(storedBodyText(poisoned), PLAIN);
  assert.equal(readableBody({ ...poisoned, snippet: "snip" }), PLAIN);
  const body = freshBody(poisoned);
  assertSafeReading(body.text, [PLAIN]);
  const lanes = shapeThread(conversation([poisoned]), "company.example", VICTIM);
  assert.equal(lanes.length, 1);
  assert.equal(lanes[0].kind, "turn");
  if (lanes[0].kind !== "turn") return;
  assertSafeReading(lanes[0].body, [PLAIN]);
});

await check("html-only body is readable by the sync and read helpers", () => {
  const htmlOnly = message({
    bodyText: null,
    bodyHtml: HEX_HTML,
    snippet: "Invoice",
  });
  const stored = storedBodyText(htmlOnly);
  assert.equal(typeof stored, "string");
  assertSafeReading(stored ?? "", ["Invoice", "is attached"]);
  const fromRow = messageFromReadRow({
    provider_message_id: "html-only",
    from_email: ATTACKER,
    from_name: "Outside Sender",
    to_emails: [VICTIM],
    cc_emails: [],
    sent_at: "2026-08-04T09:00:00.000Z",
    body_html: HEX_HTML,
    body_text: null,
    snippet: "Invoice",
    is_unread: true,
    is_outgoing: false,
    attachment_names: [],
  });
  assert.ok(fromRow);
  assertSafeReading(fromRow.bodyText ?? "", ["Invoice", "is attached"]);
  const payload = conversationPayload(conversation([fromRow], "Invoice"));
  assertSafeReading(JSON.stringify(payload), ["Invoice", "is attached"]);
});

let db: TestDb | null = null;
try {
  db = await startTestDb();
  const userId = await upsertUser(VICTIM);
  const accountId = await upsertAccount({
    userId,
    provider: "google",
    email: VICTIM,
  });

  const threads = {
    "thread-plain": gmailMessage({
      id: "m-plain",
      threadId: "thread-plain",
      subject: "Hello",
      text: "Hello from a colleague.",
      html: "<p>Hello from a colleague.</p>",
    }),
    "thread-multipart": gmailMessage({
      id: "m-multi",
      threadId: "thread-multipart",
      subject: "Board packet",
      text: PLAIN,
      html: DECIMAL_HTML,
    }),
    "thread-html": gmailMessage({
      id: "m-html",
      threadId: "thread-html",
      subject: "Invoice",
      html: HEX_HTML,
    }),
  };

  const provider = new GmailProvider({
    accessToken: "test-access-token",
    accountEmail: VICTIM,
    fetchImpl: async (input) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("/threads") && !url.searchParams.has("format")) {
        return Response.json({
          threads: Object.keys(threads).map((id) => ({ id })),
          resultSizeEstimate: Object.keys(threads).length,
        });
      }
      const threadId = url.pathname.split("/").pop() ?? "";
      const message = threads[threadId as keyof typeof threads];
      if (!message) {
        return Response.json({ error: `unexpected ${url.pathname}` }, { status: 404 });
      }
      return Response.json({ id: threadId, messages: [message] });
    },
  });

  await check("gmail sync stores the poison and a later sync does not retry it as failed", async () => {
    const first = await syncAccount(accountId, provider, "full");
    const storedIds = await db!.pool.query<{ provider_conversation_id: string }>(
      `select provider_conversation_id from seer.conversations where account_id = $1 order by 1`,
      [accountId],
    );
    const present = storedIds.rows.map((row) => row.provider_conversation_id).join(",");
    assert.equal(
      first.coverage.failed,
      0,
      `one bad body must not fail the conversation save (stored ${first.coverage.stored}: ${present})`,
    );
    assert.equal(first.coverage.stored, 3, `plain, multipart, and html-only threads are stored (${present})`);

    const stored = await db!.pool.query<{
      provider_conversation_id: string;
      body_html: string | null;
      body_text: string | null;
    }>(
      `select c.provider_conversation_id, m.body_html, m.body_text
         from seer.conversations c
         join seer.messages m on m.conversation_id = c.id
        where c.account_id = $1
        order by c.provider_conversation_id`,
      [accountId],
    );
    const byThread = new Map(stored.rows.map((row) => [row.provider_conversation_id, row]));
    const multipart = byThread.get("thread-multipart");
    assert.ok(multipart, "multipart message was stored");
    assert.match(multipart.body_html ?? "", /&#1114112;/, "the bad reference is kept in the HTML body");
    assert.match(multipart.body_text ?? "", /board packet closes on the 22nd/);

    const htmlOnly = byThread.get("thread-html");
    assert.ok(htmlOnly, "html-only message was stored");
    assertSafeReading(htmlOnly.body_text ?? "", ["Invoice", "is attached"]);

    const second = await syncAccount(accountId, provider, "full");
    assert.equal(second.coverage.failed, 0, "the same mail must not fail the next sync");
    assert.equal(second.coverage.stored, 3);
  });

  await check("opened corpus thread and the read queue survive the stored reference", async () => {
    const rows = await db!.pool.query<{ id: string; provider_conversation_id: string }>(
      `select id, provider_conversation_id
         from seer.conversations
        where account_id = $1`,
      [accountId],
    );
    const multipartId = rows.rows.find((row) => row.provider_conversation_id === "thread-multipart")?.id;
    const htmlId = rows.rows.find((row) => row.provider_conversation_id === "thread-html")?.id;
    assert.ok(multipartId, "multipart conversation id");

    const opened = await getCorpusConversation(accountId, multipartId, "google");
    assert.ok(opened);
    assert.match(opened.conversation.messages[0].bodyHtml ?? "", /&#1114112;/);
    // The read job loads text and skips HTML when a text part was stored, so
    // the prompt is the plain part. The reader still decodes the HTML body.
    const loadedMultipart = await loadConversation(multipartId);
    assert.ok(loadedMultipart);
    assert.match(JSON.stringify(conversationPayload(loadedMultipart)), /board packet closes on the 22nd/);
    const lanes = shapeThread(opened.conversation, "company.example", VICTIM);
    assert.equal(lanes[0]?.kind, "turn");
    if (lanes[0]?.kind === "turn") assertSafeReading(lanes[0].body, [PLAIN]);

    assert.ok(htmlId, "html-only conversation id");
    const htmlOpened = await getCorpusConversation(accountId, htmlId, "google");
    assert.ok(htmlOpened);
    const htmlLanes = shapeThread(htmlOpened.conversation, "company.example", VICTIM);
    assert.equal(htmlLanes[0]?.kind, "turn");
    if (htmlLanes[0]?.kind === "turn") {
      assertSafeReading(htmlLanes[0].body, ["Invoice", "is attached"]);
    }

    const queued = await conversationsNeedingRead(accountId, 10);
    assert.ok(queued.includes(htmlId as never), "html-only thread is queued for a read");
    assert.ok(queued.includes(multipartId as never), "multipart thread is queued for a read");
    for (const id of [htmlId, multipartId]) {
      const loaded = await loadConversation(id);
      assert.ok(loaded, `loadConversation ${id}`);
      const payload = conversationPayload(loaded);
      assert.equal(typeof payload.subject, "string");
      assertSafeReading(JSON.stringify(payload), []);
    }
    const htmlLoaded = await loadConversation(htmlId);
    assertSafeReading(JSON.stringify(conversationPayload(htmlLoaded!)), ["Invoice", "is attached"]);
  });
} finally {
  await db?.stop();
}

await check("opening the thread does not replace the client, and a reload stays on it", async () => {
  const { JSDOM } = await import("jsdom");
  const { act } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const dom = new JSDOM("<!doctype html><html><body></body></html>", {
    pretendToBeVisual: true,
    url: "http://localhost/",
  });
  const { window } = dom;
  const globals = globalThis as unknown as Record<string, unknown>;
  globals.window = window;
  globals.document = window.document;
  Object.defineProperty(globals, "navigator", {
    value: window.navigator,
    configurable: true,
  });
  globals.HTMLElement = window.HTMLElement;
  globals.Element = window.Element;
  globals.Node = window.Node;
  globals.Event = window.Event;
  globals.MouseEvent = window.MouseEvent;
  globals.KeyboardEvent = window.KeyboardEvent;
  globals.requestAnimationFrame = window.requestAnimationFrame.bind(window);
  globals.cancelAnimationFrame = window.cancelAnimationFrame.bind(window);
  globals.getComputedStyle = window.getComputedStyle.bind(window);
  globals.IS_REACT_ACT_ENVIRONMENT = true;
  if (!window.matchMedia) {
    window.matchMedia = ((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener() {},
      removeListener() {},
      addEventListener() {},
      removeEventListener() {},
      dispatchEvent() {
        return false;
      },
    })) as typeof window.matchMedia;
  }

  const conversationId = "conv-poison";
  let releaseBody: (() => void) | null = null;
  const held = new Promise<void>((resolve) => {
    releaseBody = resolve;
  });
  let conversationFetches = 0;
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url.includes("/api/v3/accounts")) {
      return Response.json({ active: { id: "acct-1" } });
    }
    if (url.includes("/api/v3/mailbox")) {
      return Response.json({
        catchingUp: false,
        view: {
          accountId: "acct-1",
          folder: "inbox",
          sort: "date",
          total: 1,
          needsYou: 1,
          nextCursor: null,
          rows: [
            {
              conversationId,
              providerConversationId: "thread-multipart",
              latestMessageId: "m-multi",
              senderDisplayName: "Outside Sender",
              subject: "Board packet",
              timestamp: "2026-08-04T09:00:00.000Z",
              isUnread: true,
              snippet: PLAIN,
              attachments: [],
              decisionSummary: null,
              priority: null,
              dueDate: null,
              matterTitle: null,
              disposition: "pending",
              owner: "you",
              deleteRank: 3,
              deleteToken: null,
              category: null,
              vetoReasons: [],
            },
          ],
        },
      });
    }
    if (url.includes(`/api/v3/conversations/${encodeURIComponent(conversationId)}`)) {
      conversationFetches += 1;
      await held;
      return Response.json({
        provider: "google",
        ownEmail: VICTIM,
        conversation: conversation([
          message({
            providerMessageId: "m-multi",
            bodyText: PLAIN,
            bodyHtml: DECIMAL_HTML,
          }),
        ]),
      });
    }
    return previousFetch(input);
  };

  const { MailClient } = await import("../src/components/v3/MailClient.tsx");
  const container = window.document.createElement("div");
  window.document.body.appendChild(container);
  const root = createRoot(container);
  const renderClient = () => {
    root.render(
      createElement(ErrorBoundaryHandler, {
        pathname: "/",
        errorComponent: AppError,
        children: createElement(MailClient),
      }),
    );
  };

  try {
    await act(async () => {
      renderClient();
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
    const button = container.querySelector<HTMLButtonElement>(".mobile-mail-row-button");
    assert.ok(button, `mailbox row did not render: ${container.textContent}`);
    await act(async () => {
      button.click();
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    assert.match(
      window.location.hash,
      new RegExp(`conversation=${conversationId}`),
      "the open conversation is written to the hash while the body is still loading",
    );
    assert.match(container.textContent ?? "", /Opening conversation/);
    await act(async () => {
      releaseBody?.();
      await held;
      await new Promise((resolve) => setTimeout(resolve, 30));
    });
    const hashAfterOpen = window.location.hash;
    const afterOpen = `${container.textContent ?? ""}\n${container.innerHTML}`;

    await act(async () => {
      root.unmount();
    });
    const reloaded = createRoot(container);
    await act(async () => {
      reloaded.render(
        createElement(ErrorBoundaryHandler, {
          pathname: "/",
          errorComponent: AppError,
          children: createElement(MailClient),
        }),
      );
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
    const afterReload = `${container.textContent ?? ""}\n${container.innerHTML}`;
    assert.match(hashAfterOpen, new RegExp(`conversation=${conversationId}`));
    assert.equal(
      afterOpen.includes("Something in Seer stopped working"),
      false,
      `the error screen replaced the client:\n${afterOpen.slice(0, 400)}`,
    );
    assert.match(afterOpen, /board packet closes on the 22nd/);
    assert.equal(
      afterReload.includes("Something in Seer stopped working"),
      false,
      `reload opened the hash and the error screen returned:\n${afterReload.slice(0, 400)}`,
    );
    assert.match(afterReload, /board packet closes on the 22nd/);
    await act(async () => {
      reloaded.unmount();
    });
  } finally {
    globalThis.fetch = previousFetch;
  }
});

if (failures.length > 0) {
  console.error(`\n${failures.length} check(s) failed`);
  process.exit(1);
}
console.log("numeric-character-reference: OK");
