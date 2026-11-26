/**
 * Gmail threads.get returns every message in the conversation, including
 * ones labeled DRAFT, TRASH, or SPAM (Gmail API v1 discovery, revision
 * 20261116: Thread.messages is "The list of messages in the thread", and
 * threads.get has no includeSpamTrash switch). Forward and reply must
 * not treat those as messages the user sent or as the reply target.
 *
 * These assertions fail while the adapter maps the thread unfiltered.
 */
import assert from "node:assert/strict";
import { GmailProvider } from "../src/lib/v2/providers/gmail.ts";

const THREAD_ID = "thread-pricing";
const SELF = "me@example.com";
const PUBLIC_BODY = "PUBLIC_TERMS_SEVENTY";
const DRAFT_BODY = "DO_NOT_EXCEED_FORTY";
const TRASH_BODY = "RETRACTED_NUMBER_TWELVE";
const SPAM_BODY = "SPAM_PHISH_BODY";
const PUBLIC_FROM = "outside.party@example.com";
const PUBLIC_CC = "counsel@example.com";
const DRAFT_TO = "private.negotiator@example.com";
const DRAFT_CC = "hidden.partner@example.com";
const TRASH_FROM = "retracted.sender@example.com";
const SPAM_FROM = "spammer@example.com";
const FORWARD_NOTE = "Please see the public thread";
const REPLY_NOTE = "Thanks, confirming the public terms";

function b64url(s: string): string {
  return Buffer.from(s, "utf8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/**
 * Message shape from Gmail API v1 Message: id, threadId, labelIds,
 * snippet, internalDate, payload.headers, payload.mimeType, payload.body
 * or payload.parts. System label names DRAFT, TRASH, and SPAM are the
 * reserved labels from the Gmail labels guide.
 */
function message(input: {
  id: string;
  labelIds: string[];
  internalDate: string;
  from: string;
  to: string;
  cc?: string;
  subject: string;
  text?: string;
  html?: string;
  snippet: string;
}) {
  const headers = [
    { name: "From", value: input.from },
    { name: "To", value: input.to },
    { name: "Subject", value: input.subject },
  ];
  if (input.cc) headers.push({ name: "Cc", value: input.cc });
  const parts = [];
  if (input.text) {
    parts.push({
      mimeType: "text/plain",
      body: { size: input.text.length, data: b64url(input.text) },
    });
  }
  if (input.html) {
    parts.push({
      mimeType: "text/html",
      body: { size: input.html.length, data: b64url(input.html) },
    });
  }
  return {
    id: input.id,
    threadId: THREAD_ID,
    labelIds: input.labelIds,
    snippet: input.snippet,
    internalDate: input.internalDate,
    payload:
      parts.length === 1
        ? { mimeType: parts[0].mimeType, headers, body: parts[0].body }
        : { mimeType: "multipart/alternative", headers, parts },
  };
}

/** Oldest first, matching a chronological threads.get payload. */
const threadMessages = [
  message({
    id: "m-public",
    labelIds: ["INBOX", "UNREAD"],
    internalDate: "1700000000000",
    from: `Outside Party <${PUBLIC_FROM}>`,
    to: `Me <${SELF}>`,
    cc: `Counsel <${PUBLIC_CC}>`,
    subject: "Pricing thread",
    text: PUBLIC_BODY,
    html: `<p>${PUBLIC_BODY}</p>`,
    snippet: PUBLIC_BODY,
  }),
  message({
    id: "m-trash",
    labelIds: ["TRASH"],
    internalDate: "1700000001000",
    from: `Retracted <${TRASH_FROM}>`,
    to: `Me <${SELF}>`,
    subject: "Pricing thread",
    text: TRASH_BODY,
    snippet: TRASH_BODY,
  }),
  message({
    id: "m-spam",
    labelIds: ["SPAM"],
    internalDate: "1700000002000",
    from: `Spammer <${SPAM_FROM}>`,
    to: `Me <${SELF}>`,
    subject: "Pricing thread",
    html: `<p>${SPAM_BODY}</p>`,
    snippet: SPAM_BODY,
  }),
  message({
    id: "m-draft",
    labelIds: ["DRAFT"],
    internalDate: "1700000003000",
    from: `Me <${SELF}>`,
    to: `Negotiator <${DRAFT_TO}>`,
    cc: `Hidden <${DRAFT_CC}>`,
    subject: "Pricing thread",
    html: `<p>${DRAFT_BODY}</p>`,
    snippet: DRAFT_BODY,
  }),
];

let threadGets = 0;
let sends: string[] = [];

const mockFetch = (async (url: string, init?: RequestInit) => {
  const u = String(url);
  const method = init?.method ?? "GET";
  const threadGet = u.match(/\/gmail\/v1\/users\/me\/threads\/([^?]+)\?format=full$/);
  if (method === "GET" && threadGet) {
    assert.equal(decodeURIComponent(threadGet[1]), THREAD_ID);
    threadGets += 1;
    // A new object every time, so a filter of a previous response cannot
    // leak into a later fetch that the send path actually uses.
    return json({
      id: THREAD_ID,
      messages: threadMessages.map((m) => structuredClone(m)),
    });
  }
  if (method === "POST" && u.endsWith("/gmail/v1/users/me/messages/send")) {
    const body = JSON.parse(String(init?.body ?? "{}")) as { raw?: string };
    const raw = body.raw ?? "";
    const padded = raw.replace(/-/g, "+").replace(/_/g, "/");
    sends.push(Buffer.from(padded, "base64").toString("utf8"));
    return json({ id: `sent-${sends.length}`, threadId: THREAD_ID });
  }
  throw new Error(`unexpected request: ${method} ${u}`);
}) as unknown as typeof fetch;

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function headerValue(mime: string, name: string): string {
  const line = mime
    .split("\r\n")
    .find((row) => row.toLowerCase().startsWith(`${name.toLowerCase()}:`));
  assert.ok(line, `missing ${name} header`);
  return line.slice(name.length + 1).trim();
}

function addresses(header: string): Set<string> {
  return new Set(
    header
      .split(",")
      .map((part) => part.trim().toLowerCase())
      .filter(Boolean),
  );
}

function provider(): GmailProvider {
  return new GmailProvider({
    accessToken: "test-token",
    accountEmail: SELF,
    fetchImpl: mockFetch,
  });
}

const leaked = [DRAFT_BODY, TRASH_BODY, SPAM_BODY, DRAFT_TO, DRAFT_CC, TRASH_FROM, SPAM_FROM];

function assertNoLeakedContent(mime: string, label: string): void {
  for (const secret of leaked) {
    assert.equal(
      mime.includes(secret),
      false,
      `${label} included ${secret}`,
    );
  }
}

// Forward quotes the thread into the message posted to messages.send.
{
  sends = [];
  threadGets = 0;
  const receipt = await provider().forward(
    {
      conversationId: THREAD_ID,
      to: [{ email: "colleague@example.com" }],
      bodyHtml: `<p>${FORWARD_NOTE}</p>`,
    },
    "forward-key",
  );
  assert.equal(receipt.providerMessageId, "sent-1");
  assert.equal(sends.length, 1);
  assert.ok(threadGets >= 1, "forward must load the thread");
  const mime = sends[0];
  assert.equal(headerValue(mime, "To"), "colleague@example.com");
  assert.match(headerValue(mime, "Subject"), /^Fwd: Pricing thread$/);
  assert.ok(mime.includes(FORWARD_NOTE), "forward keeps the user's note");
  assert.ok(mime.includes(PUBLIC_BODY), "forward keeps the real message");
  assert.ok(mime.includes(PUBLIC_FROM), "forward keeps the real sender");
  assert.ok(mime.includes(PUBLIC_CC), "forward keeps the real cc");
  assertNoLeakedContent(mime, "forward");
}

// Reply addresses the last real message, not a newer draft, trash, or spam.
{
  sends = [];
  const before = threadGets;
  await provider().reply(
    { conversationId: THREAD_ID, all: false, bodyHtml: `<p>${REPLY_NOTE}</p>` },
    "reply-key",
  );
  assert.ok(threadGets > before, "reply must load the thread");
  assert.equal(sends.length, 1);
  const mime = sends[0];
  assert.deepEqual(addresses(headerValue(mime, "To")), new Set([PUBLIC_FROM]));
  assert.match(headerValue(mime, "Subject"), /^Re: Pricing thread$/);
  assert.ok(mime.includes(REPLY_NOTE));
  assertNoLeakedContent(mime, "reply");
}

// Reply-all uses the same last real message's recipients, excluding self.
{
  sends = [];
  await provider().reply(
    { conversationId: THREAD_ID, all: true, bodyHtml: `<p>${REPLY_NOTE}</p>` },
    "reply-all-key",
  );
  assert.equal(sends.length, 1);
  const mime = sends[0];
  assert.deepEqual(
    addresses(headerValue(mime, "To")),
    new Set([PUBLIC_FROM, PUBLIC_CC]),
  );
  assertNoLeakedContent(mime, "reply-all");
}

console.log("v2-gmail-draft-trash-forward: OK");
