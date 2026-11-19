/**
 * A sender-controlled quote marker must not be the last copy of a message
 * the reading pane can show.
 *
 * These tests fail while the pane cuts at a Gmail, Outlook, or plain-text
 * marker and then renders only the prefix. They pass once the opened pane
 * still contains the sanitized text that followed the marker. A count of
 * hidden quotes is not that text.
 *
 * Sync stores the provider body unchanged (body_html is the HTML part,
 * body_text is storedBodyText). The corpus reader loads those columns back
 * onto the message. The tests apply that same text derivation, then render
 * the pane the mail client opens.
 */
import assert from "node:assert/strict";
import { createElement, type ReactElement } from "react";
import { renderToString } from "react-dom/server";
import { JSDOM } from "jsdom";
import { storedBodyText } from "../src/lib/v2/intelligence/html-text.ts";
import { GmailProvider } from "../src/lib/v2/providers/gmail.ts";
import { OutlookProvider } from "../src/lib/v2/providers/outlook.ts";
import type { Conversation, Message } from "../src/lib/v2/providers/types.ts";
import { getGmailMessage } from "../src/lib/mail/gmail.ts";
import { getGraphMessage } from "../src/lib/mail/graph.ts";
import type { ReaderMessage } from "../src/lib/inbox/types.ts";

// DOMPurify (used when the pane actually mounts HTML) builds itself from the
// window present at import time. Install one before the reader modules load.
const dom = new JSDOM("<!doctype html><html><body></body></html>", {
  pretendToBeVisual: true,
  url: "http://localhost/",
});
const globals = globalThis as unknown as Record<string, unknown>;
globals.window = dom.window;
globals.document = dom.window.document;
Object.defineProperty(globals, "navigator", {
  value: dom.window.navigator,
  configurable: true,
});
globals.HTMLElement = dom.window.HTMLElement;
globals.Element = dom.window.Element;
globals.Node = dom.window.Node;
globals.DOMParser = dom.window.DOMParser;

const { Reader } = await import("../src/components/v2/Reader.tsx");
const { LegacyThread } = await import("../src/components/mail/LegacyThread.tsx");

const BENIGN = "Thanks, the draft looks fine.";
const HIDDEN = "PAYMENT-INSTRUCTION-88421";
const OWN = "reader@example.com";
const ACCESS = "placeholder-token";

const failures: string[] = [];

function b64url(value: string): string {
  return Buffer.from(value, "utf8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function paneHtml(node: ReactElement): string {
  return renderToString(node).replace(/<!--[\s\S]*?-->/g, "");
}

function expectBody(html: string, where: string) {
  if (!html.includes(BENIGN)) {
    failures.push(`${where}: the prefix is not in the opened pane`);
  }
  if (!html.includes(HIDDEN)) {
    failures.push(
      `${where}: the text after the quote marker is not in the opened pane`,
    );
  }
}

function message(over: Partial<Message>): Message {
  return {
    providerMessageId: "m-attack",
    from: { email: "sender@other.test", name: "Pat Sender" },
    to: [{ email: OWN, name: "Reader" }],
    cc: [],
    sentAt: "2026-08-14T10:00:00.000Z",
    snippet: BENIGN,
    bodyHtml: null,
    bodyText: null,
    isUnread: true,
    isOutgoing: false,
    attachments: [],
    ...over,
  };
}

/** The columns the corpus reader hands back: HTML unchanged, text derived. */
function asStored(raw: Message): Message {
  return { ...raw, bodyText: storedBodyText(raw) };
}

function conversation(raw: Message): Conversation {
  const stored = asStored(raw);
  return {
    providerConversationId: "c-attack",
    subject: "Draft notes",
    messages: [stored],
    lastMessageAt: stored.sentAt,
  };
}

function renderReader(raw: Message, ownEmail = OWN, focusMessageId?: string): string {
  return paneHtml(
    createElement(Reader, {
      provider: "google",
      conversation: conversation(raw),
      ownEmail,
      focusMessageId,
      onReply() {},
      onReplyAll() {},
      onForward() {},
      onArchive() {},
      onDelete() {},
    }),
  );
}

const htmlMarkers: Array<[string, string]> = [
  [
    "gmail_quote class",
    `<p>${BENIGN}</p><div class="gmail_quote"><p>${HIDDEN}</p></div>`,
  ],
  [
    "Outlook appendonsend",
    `<p>${BENIGN}</p><div id="appendonsend"></div><p>${HIDDEN}</p>`,
  ],
  [
    "Outlook divRplyFwdMsg",
    `<p>${BENIGN}</p><div id="divRplyFwdMsg"><div>From: Pat</div></div><p>${HIDDEN}</p>`,
  ],
  [
    "Thunderbird moz-cite-prefix",
    `<p>${BENIGN}</p><div class="moz-cite-prefix"><p>${HIDDEN}</p></div>`,
  ],
  [
    "Yahoo quoted wrapper",
    `<p>${BENIGN}</p><div id="yahoo_quoted_1"><p>${HIDDEN}</p></div>`,
  ],
  [
    "blockquote type=cite",
    `<p>${BENIGN}</p><blockquote type="cite"><p>${HIDDEN}</p></blockquote>`,
  ],
  [
    "blockquote class gmail_quote",
    `<p>${BENIGN}</p><blockquote class="gmail_quote"><p>${HIDDEN}</p></blockquote>`,
  ],
  [
    "Original Message divider",
    `<p>${BENIGN}</p><p>-----Original Message-----</p><p>${HIDDEN}</p>`,
  ],
  [
    "attribution before a blockquote",
    `<p>${BENIGN}</p><div>On Fri, Pat wrote:</div><blockquote><p>${HIDDEN}</p></blockquote>`,
  ],
  [
    "Outlook header before a blockquote",
    `<div>${BENIGN}</div><div>From: Pat Sender<br>Sent: Friday<br>To: Reader</div><blockquote><p>${HIDDEN}</p></blockquote>`,
  ],
];

for (const [name, html] of htmlMarkers) {
  const rendered = renderReader(
    message({
      bodyHtml: html,
      // The plain part repeats the instruction. The pane still has to show
      // it when the HTML marker is what the cutter trusts.
      bodyText: `${BENIGN}\n\n${HIDDEN}`,
    }),
  );
  expectBody(rendered, `external HTML / ${name}`);
}

const textMarkers = [
  "On Friday, 7 August 2026, Pat Sender wrote:",
  "-----Original Message-----",
  "_____",
  "From: Pat Sender <sender@other.test>",
  "Begin forwarded message:",
  "Sent from my iPhone",
];

for (const marker of textMarkers) {
  const rendered = renderReader(
    message({
      bodyHtml: null,
      bodyText: `${BENIGN}\n${marker}\n${HIDDEN}`,
    }),
  );
  expectBody(rendered, `external plain text / ${marker}`);
}

// A colleague (or anyone the lane splitter treats as internal) hits the
// branch renderer, which drops HTML on the same class names and then shows
// the already-cut text.
{
  const rendered = renderReader(
    message({
      from: { email: "colleague@example.com", name: "Colleague" },
      to: [{ email: OWN, name: "Reader" }],
      bodyHtml: `<p>${BENIGN}</p><div class="gmail_quote"><p>${HIDDEN}</p></div>`,
      bodyText: `${BENIGN}\n\n${HIDDEN}`,
    }),
    OWN,
    "m-attack",
  );
  expectBody(rendered, "internal branch / gmail_quote");
}

{
  // An unannounced blockquote is not a quote boundary in the HTML cutter, so
  // the text fallback still contains the instruction even though the branch
  // refuses to mount that HTML. This case stays visible.
  const rendered = renderReader(
    message({
      from: { email: "colleague@example.com", name: "Colleague" },
      to: [{ email: OWN, name: "Reader" }],
      bodyHtml: `<p>${BENIGN}</p><blockquote><p>${HIDDEN}</p></blockquote>`,
      bodyText: `${BENIGN}\n\n${HIDDEN}`,
    }),
    OWN,
    "m-attack",
  );
  expectBody(rendered, "internal branch / unannounced blockquote");
}

{
  const rendered = renderReader(
    message({
      from: { email: "colleague@example.com", name: "Colleague" },
      to: [{ email: OWN, name: "Reader" }],
      bodyHtml: `<p>${BENIGN}</p><blockquote type="cite"><p>${HIDDEN}</p></blockquote>`,
      bodyText: `${BENIGN}\n\n${HIDDEN}`,
    }),
    OWN,
    "m-attack",
  );
  expectBody(rendered, "internal branch / blockquote type=cite");
}

{
  const rendered = renderReader(
    message({
      from: { email: "colleague@example.com", name: "Colleague" },
      to: [{ email: OWN, name: "Reader" }],
      bodyHtml: null,
      bodyText: `${BENIGN}\nFrom: Pat Sender <sender@other.test>\n${HIDDEN}`,
    }),
    OWN,
    "m-attack",
  );
  expectBody(rendered, "internal branch / plain-text From: line");
}

{
  // The branch only suppresses HTML when the body matches gmail_quote,
  // blockquote, or Original Message. An appendonsend divider is still
  // mounted, so this instruction stays on screen.
  const rendered = renderReader(
    message({
      from: { email: "colleague@example.com", name: "Colleague" },
      to: [{ email: OWN, name: "Reader" }],
      bodyHtml: `<p>${BENIGN}</p><div id="appendonsend"></div><p>${HIDDEN}</p>`,
      bodyText: `${BENIGN}\n\n${HIDDEN}`,
    }),
    OWN,
    "m-attack",
  );
  expectBody(rendered, "internal branch / appendonsend still mounted");
}

{
  const rendered = renderReader(
    message({
      from: { email: "colleague@example.com", name: "Colleague" },
      to: [{ email: OWN, name: "Reader" }],
      bodyHtml: `<p>${BENIGN}</p><p>-----Original Message-----</p><p>${HIDDEN}</p>`,
      bodyText: `${BENIGN}\n-----Original Message-----\n${HIDDEN}`,
    }),
    OWN,
    "m-attack",
  );
  expectBody(rendered, "internal branch / Original Message");
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function gmailPayload(id: string, html: string, text: string | null) {
  const parts = [
    ...(text === null
      ? []
      : [{ mimeType: "text/plain", body: { size: text.length, data: b64url(text) } }]),
    { mimeType: "text/html", body: { size: html.length, data: b64url(html) } },
  ];
  return {
    id,
    threadId: "thread-attack",
    snippet: BENIGN,
    labelIds: ["INBOX", "UNREAD"],
    internalDate: "1755165600000",
    payload: {
      mimeType: "multipart/alternative",
      headers: [
        { name: "From", value: "Pat Sender <sender@other.test>" },
        { name: "To", value: `Reader <${OWN}>` },
        { name: "Subject", value: "Draft notes" },
      ],
      parts,
    },
  };
}

const attackHtml = `<p>${BENIGN}</p><div class="gmail_quote"><p>${HIDDEN}</p></div>`;

{
  const provider = new GmailProvider({
    accessToken: ACCESS,
    accountEmail: OWN,
    fetchImpl: async (input) => {
      const url = String(input);
      assert.match(url, /\/threads\/thread-attack\?format=full/);
      return jsonResponse({
        id: "thread-attack",
        messages: [gmailPayload("m-gmail", attackHtml, `${BENIGN}\n\n${HIDDEN}`)],
      });
    },
  });
  const fetched = await provider.getConversation("thread-attack");
  const raw = fetched.messages[0];
  assert.equal(raw?.from.email, "sender@other.test");
  assert.match(raw?.bodyHtml ?? "", new RegExp(HIDDEN));
  assert.match(raw?.bodyText ?? "", new RegExp(HIDDEN));
  expectBody(renderReader(raw), "Gmail provider HTML message");
}

{
  const provider = new OutlookProvider({
    accessToken: ACCESS,
    accountEmail: OWN,
    fetchImpl: async (input) => {
      const url = String(input);
      assert.match(url, /graph\.microsoft\.com\/v1\.0\/me\/messages\?/);
      return jsonResponse({
        value: [
          {
            id: "m-outlook",
            conversationId: "conv-attack",
            subject: "Draft notes",
            from: { emailAddress: { address: "sender@other.test", name: "Pat Sender" } },
            toRecipients: [{ emailAddress: { address: OWN, name: "Reader" } }],
            receivedDateTime: "2026-08-14T10:00:00.000Z",
            bodyPreview: BENIGN,
            body: { contentType: "html", content: `<p>${BENIGN}</p><p>-----Original Message-----</p><p>${HIDDEN}</p>` },
            isRead: false,
          },
        ],
      });
    },
  });
  const fetched = await provider.getConversation("conv-attack");
  const raw = fetched.messages[0];
  assert.match(raw?.bodyHtml ?? "", new RegExp(HIDDEN));
  assert.equal(raw?.bodyText, null);
  expectBody(renderReader(raw), "Outlook provider HTML message");
}

{
  const provider = new OutlookProvider({
    accessToken: ACCESS,
    accountEmail: OWN,
    fetchImpl: async () =>
      jsonResponse({
        value: [
          {
            id: "m-outlook-text",
            conversationId: "conv-text",
            subject: "Draft notes",
            from: { emailAddress: { address: "sender@other.test", name: "Pat Sender" } },
            toRecipients: [{ emailAddress: { address: OWN, name: "Reader" } }],
            receivedDateTime: "2026-08-14T10:00:00.000Z",
            bodyPreview: BENIGN,
            body: {
              contentType: "text",
              content: `${BENIGN}\nFrom: Pat Sender <sender@other.test>\n${HIDDEN}`,
            },
            isRead: false,
          },
        ],
      }),
  });
  const fetched = await provider.getConversation("conv-text");
  const raw = fetched.messages[0];
  assert.equal(raw?.bodyHtml, null);
  assert.match(raw?.bodyText ?? "", new RegExp(HIDDEN));
  expectBody(renderReader(raw), "Outlook provider plain-text From: line");
}

function renderLegacy(reader: ReaderMessage): string {
  return paneHtml(createElement(LegacyThread, { reader }));
}

function legacyReader(detail: {
  id: string;
  htmlBody: string;
  textBody: string;
  fromName: string;
  fromEmail: string;
  receivedAt: string;
  subject?: string;
  threadId?: string;
  toEmail?: string;
  ccEmail?: string;
  messageIdHeader?: string;
}): ReaderMessage {
  return {
    htmlBody: detail.htmlBody,
    textBody: detail.textBody,
    subject: detail.subject ?? "Draft notes",
    fromName: detail.fromName,
    fromEmail: detail.fromEmail,
    toEmail: detail.toEmail ?? OWN,
    ccEmail: detail.ccEmail ?? "",
    threadId: detail.threadId ?? "thread-attack",
    messageIdHeader: detail.messageIdHeader ?? "<m@other.test>",
    receivedAt: detail.receivedAt,
    thread: [
      {
        id: detail.id,
        htmlBody: detail.htmlBody,
        textBody: detail.textBody,
        fromName: detail.fromName,
        fromEmail: detail.fromEmail,
        receivedAt: detail.receivedAt,
      },
    ],
  };
}

async function withFetch<T>(impl: typeof fetch, run: () => Promise<T>): Promise<T> {
  const previous = globalThis.fetch;
  globalThis.fetch = impl;
  try {
    return await run();
  } finally {
    globalThis.fetch = previous;
  }
}

{
  const detail = await withFetch(async (input) => {
    const url = String(input);
    assert.match(url, /gmail\.googleapis\.com\/gmail\/v1\/users\/me\/messages\/m-gmail\?format=full/);
    return jsonResponse(gmailPayload("m-gmail", attackHtml, null));
  }, () => getGmailMessage(ACCESS, "m-gmail"));
  assert.equal(detail.textBody, "");
  assert.match(detail.htmlBody, new RegExp(HIDDEN));
  expectBody(
    renderLegacy(legacyReader(detail)),
    "legacy Gmail HTML-only gmail_quote",
  );
}

{
  const plain = `${BENIGN}\nFrom: Pat Sender <sender@other.test>\n${HIDDEN}`;
  const detail = await withFetch(async (input) => {
    const url = String(input);
    assert.match(url, /gmail\.googleapis\.com/);
    return jsonResponse(
      gmailPayload(
        "m-gmail-text",
        `<p>${BENIGN}</p><p>From: Pat Sender</p><p>${HIDDEN}</p>`,
        plain,
      ),
    );
  }, () => getGmailMessage(ACCESS, "m-gmail-text"));
  assert.match(detail.textBody, new RegExp(HIDDEN));
  expectBody(renderLegacy(legacyReader(detail)), "legacy Gmail plain-text From: line");
}

{
  const detail = await withFetch(async (input) => {
    const url = String(input);
    assert.match(url, /graph\.microsoft\.com\/v1\.0\/me\/messages\/m-graph/);
    return jsonResponse({
      id: "m-graph",
      conversationId: "conv-attack",
      subject: "Draft notes",
      from: { emailAddress: { address: "sender@other.test", name: "Pat Sender" } },
      toRecipients: [{ emailAddress: { address: OWN, name: "Reader" } }],
      receivedDateTime: "2026-08-14T10:00:00.000Z",
      bodyPreview: BENIGN,
      body: {
        contentType: "html",
        content: `<p>${BENIGN}</p><div class="gmail_quote"><p>${HIDDEN}</p></div>`,
      },
      isRead: false,
      hasAttachments: false,
      internetMessageId: "<m-graph@other.test>",
    });
  }, () => getGraphMessage(ACCESS, "m-graph"));
  assert.equal(detail.textBody, BENIGN);
  assert.match(detail.htmlBody, new RegExp(HIDDEN));
  expectBody(
    renderLegacy(legacyReader(detail)),
    "legacy Outlook HTML with preview text only",
  );
}

if (failures.length > 0) {
  throw new Error(
    `${failures.length} reading-pane case(s) hid the message body:\n` +
      failures.map((failure) => `- ${failure}`).join("\n"),
  );
}

console.log("quote-marker-reading-pane: OK");
