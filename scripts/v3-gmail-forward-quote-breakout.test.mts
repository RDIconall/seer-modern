/**
 * Gmail forward must not let a quoted HTML body break out of its quote.
 *
 * The compose pane shows each earlier message in its own sandboxed frame after
 * sanitizing. On send, GmailProvider.forward fetches the thread and pastes
 * every text/html body into one text/html MIME part under the forwarder's
 * note. These tests run that adapter: a stand-in only supplies the Gmail
 * JSON the adapter already decodes. They fail while a quoted body can close
 * the quote wrapper, and they still fail if the finished document is
 * sanitized only after the bodies have been concatenated — the parser has
 * already closed the wrapper by then. Escape or sanitize each quoted body
 * before it is inserted, and keep the forwarder's note outside that markup.
 *
 * Plain-text bodies and header values are escaped today. Those checks stay
 * green so a fix does not trade one hole for the other.
 */
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { GmailProvider } from "../src/lib/v2/providers/gmail.ts";

const PAY_HREF = "https://evil.example/pay";
const OLDER_HREF = "https://evil.example/older";
const NAME_HREF = "https://evil.example/name";
const PLAIN_HREF = "https://evil.example/plain";
const NOTE = "Please review the thread below.";
const NESTED_BREAKOUT = "Please use this account instead.";
const OLDER_BREAKOUT = "Wire the older balance today.";
const PLAIN_TEXT = "Plain body stays text.";

function b64url(value: string): string {
  return Buffer.from(value, "utf8").toString("base64url");
}

function headers(from: string, subject: string) {
  return [
    { name: "From", value: from },
    { name: "To", value: "Victim <victim@example.com>" },
    { name: "Cc", value: "Colleague <colleague@example.com>" },
    { name: "Subject", value: subject },
  ];
}

/** multipart/mixed → multipart/alternative, the shape Gmail returns for an HTML mail. */
function nestedHtmlMessage(input: {
  id: string;
  threadId: string;
  epoch: number;
  from: string;
  subject: string;
  plain: string;
  html: string;
}) {
  return {
    id: input.id,
    threadId: input.threadId,
    snippet: "snippet",
    labelIds: ["INBOX"],
    internalDate: String(input.epoch),
    payload: {
      mimeType: "multipart/mixed",
      headers: headers(input.from, input.subject),
      parts: [
        {
          mimeType: "multipart/alternative",
          parts: [
            { mimeType: "text/plain", body: { size: input.plain.length, data: b64url(input.plain) } },
            { mimeType: "text/html", body: { size: input.html.length, data: b64url(input.html) } },
          ],
        },
      ],
    },
  };
}

/** A text/html part on the payload itself, not nested under multipart. */
function singleHtmlMessage(input: {
  id: string;
  threadId: string;
  epoch: number;
  from: string;
  subject: string;
  html: string;
}) {
  return {
    id: input.id,
    threadId: input.threadId,
    snippet: "snippet",
    labelIds: ["INBOX"],
    internalDate: String(input.epoch),
    payload: {
      mimeType: "text/html",
      headers: headers(input.from, input.subject),
      body: { size: input.html.length, data: b64url(input.html) },
    },
  };
}

function plainMessage(input: {
  id: string;
  threadId: string;
  epoch: number;
  from: string;
  subject: string;
  text: string;
}) {
  return {
    id: input.id,
    threadId: input.threadId,
    snippet: "snippet",
    labelIds: ["INBOX"],
    internalDate: String(input.epoch),
    payload: {
      mimeType: "text/plain",
      headers: headers(input.from, input.subject),
      body: { size: input.text.length, data: b64url(input.text) },
    },
  };
}

const THREADS: Record<string, { id: string; messages: unknown[] }> = {
  nested: {
    id: "nested",
    messages: [
      plainMessage({
        id: "nested-plain",
        threadId: "nested",
        epoch: 1_600_000_100_000,
        from: `Plain Sender <plain@example.com>`,
        subject: "Status",
        text: `</div><a href="${PLAIN_HREF}">plain link</a><script>alert(1)</script>\n${PLAIN_TEXT}`,
      }),
      nestedHtmlMessage({
        id: "nested-html",
        threadId: "nested",
        epoch: 1_600_000_200_000,
        from: `Acme </div><a href="${NAME_HREF}">name breakout</a> <attacker@example.com>`,
        subject: "Invoice",
        plain: "Wire nothing, this is the plain part.",
        html: [
          "<p>Original request attached.</p>",
          `</div><p>${NESTED_BREAKOUT}</p>`,
          `<a href="${PAY_HREF}">Updated payment link</a>`,
          "<script>alert(1)</script>",
          '<img src="x" onerror="alert(1)">',
          "<div>",
        ].join(""),
      }),
    ],
  },
  single: {
    id: "single",
    messages: [
      singleHtmlMessage({
        id: "single-html",
        threadId: "single",
        epoch: 1_600_000_300_000,
        from: "Older Sender <older@example.com>",
        subject: "Balance",
        html: `</DIV\n><p>${OLDER_BREAKOUT}</p><a href="${OLDER_HREF}">Older payment link</a><div>`,
      }),
    ],
  },
};

let lastMime = "";

const mockFetch = (async (url: string, init?: RequestInit) => {
  const method = (init?.method ?? "GET").toUpperCase();
  const u = String(url);
  const threadGet = u.match(/\/threads\/([^/?]+)\?format=full/);
  if (method === "GET" && threadGet) {
    const thread = THREADS[decodeURIComponent(threadGet[1])];
    if (!thread) return new Response("not found", { status: 404 });
    return new Response(JSON.stringify(thread), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }
  if (method === "POST" && u.endsWith("/messages/send")) {
    const body = JSON.parse(String(init?.body ?? "{}")) as { raw?: string };
    const raw = body.raw ?? "";
    lastMime = Buffer.from(raw.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
    return new Response(JSON.stringify({ id: "sent-1", threadId: "sent-thread" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }
  throw new Error(`unexpected request: ${method} ${u}`);
}) as typeof fetch;

function htmlPart(mime: string): string {
  const sep = mime.indexOf("\r\n\r\n");
  assert.ok(sep > 0, "outbound MIME has a header/body split");
  const headers = mime.slice(0, sep);
  assert.match(headers, /^To: recipient@example\.com/m);
  assert.match(headers, /^Subject: Fwd: /m);
  assert.match(headers, /^Content-Type: text\/html; charset="UTF-8"/m);
  assert.equal(headers.includes("multipart/"), false);
  return mime.slice(sep + 4);
}

/**
 * The quote that owns a header is the wrapper the product opened for that
 * message. Forged quote elements in the body do not count: the header is
 * written before the body, so the first header for this address is the
 * product's. The quoted instructions have to stay inside that element.
 */
function quoteFor(document: Document, email: string): HTMLElement {
  const header = [...document.querySelectorAll(".seer-quote-header")].find((node) =>
    node.textContent?.includes(email),
  );
  assert.ok(header, `quote header for ${email} missing`);
  const quote = header.closest(".seer-quote");
  assert.ok(quote, `quote wrapper for ${email} missing`);
  return quote as HTMLElement;
}

function assertBodyStaysInQuote(
  document: Document,
  email: string,
  instruction: string,
  href: string,
): void {
  const quote = quoteFor(document, email);
  assert.ok(
    quote.textContent?.includes(instruction),
    `${email}: quoted instructions escaped the quote that carries their header`,
  );
  const links = [...document.querySelectorAll("a")].filter(
    (anchor) => anchor.getAttribute("href") === href,
  );
  for (const link of links) {
    assert.ok(
      quote.contains(link),
      `${email}: quoted link ${href} is outside its quote`,
    );
  }
}

function assertNoActiveMarkup(document: Document): void {
  assert.equal(document.querySelectorAll("script").length, 0, "quoted script must not survive");
  const active = [...document.querySelectorAll("*")].filter((node) =>
    [...node.attributes].some((attr) => attr.name.toLowerCase().startsWith("on")),
  );
  assert.equal(active.length, 0, "quoted event handlers must not survive");
  assert.equal(
    document.querySelector(`a[href="${NAME_HREF}"]`),
    null,
    "a display name must not become a link",
  );
  assert.equal(
    document.querySelector(`a[href="${PLAIN_HREF}"]`),
    null,
    "a plain-text body must not become a link",
  );
}

const provider = new GmailProvider({
  accessToken: "test-token",
  accountEmail: "victim@example.com",
  fetchImpl: mockFetch,
});

{
  await provider.forward(
    {
      conversationId: "nested",
      to: [{ email: "recipient@example.com" }],
      bodyHtml: `<p id="forwarder-note">${NOTE}</p>`,
    },
    "forward-nested",
  );
  const html = htmlPart(lastMime);
  const document = new JSDOM(html).window.document;
  const note = document.getElementById("forwarder-note");
  assert.ok(note, "forwarder note missing from the text/html part");
  assert.equal(note.textContent, NOTE);
  assert.equal(note.closest(".seer-quote"), null, "forwarder note must sit outside the quote");

  assertBodyStaysInQuote(document, "attacker@example.com", NESTED_BREAKOUT, PAY_HREF);
  assertBodyStaysInQuote(document, "plain@example.com", PLAIN_TEXT, PLAIN_HREF);
  assertNoActiveMarkup(document);
}

{
  await provider.forward(
    {
      conversationId: "single",
      to: [{ email: "recipient@example.com" }],
      bodyHtml: `<p id="forwarder-note">${NOTE}</p>`,
    },
    "forward-single",
  );
  const document = new JSDOM(htmlPart(lastMime)).window.document;
  assertBodyStaysInQuote(document, "older@example.com", OLDER_BREAKOUT, OLDER_HREF);
  assertNoActiveMarkup(document);
}

console.log("v3-gmail-forward-quote-breakout: OK");
