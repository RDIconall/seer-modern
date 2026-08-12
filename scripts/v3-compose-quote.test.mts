/**
 * Outlook-style quoted thread builder + Gmail forward body that shares it.
 */
import assert from "node:assert/strict";
import {
  escapeHtml,
  formatAddress,
  formatAddressList,
  formatSentAt,
  hasAttachments,
  quoteHeaderLines,
  quotedThreadHtml,
} from "../src/lib/v3/compose/quoted-thread.ts";
import { gmailForwardHtml } from "../src/lib/v2/providers/forward-html.ts";
import type { Conversation, Message } from "../src/lib/v2/providers/types.ts";

function message(partial: Partial<Message> & Pick<Message, "providerMessageId" | "sentAt">): Message {
  return {
    from: { email: "alice@example.com", name: "Alice" },
    to: [{ email: "bob@example.com", name: "Bob" }],
    cc: [],
    snippet: "snippet",
    bodyHtml: null,
    bodyText: null,
    isUnread: false,
    isOutgoing: false,
    attachments: [],
    ...partial,
  };
}

{
  assert.equal(formatSentAt("2026-08-12T15:20:00.000Z"), "Wednesday, 12 August 2026 15:20");
  assert.equal(formatSentAt("not-a-date"), "");
}

{
  assert.equal(
    formatAddress({ email: "sandra@example.com", name: "Sandra Yasavul" }),
    "Sandra Yasavul <sandra@example.com>",
  );
  assert.equal(formatAddress({ email: "bare@example.com" }), "bare@example.com");
  assert.equal(
    formatAddressList([
      { email: "a@example.com", name: "A" },
      { email: "b@example.com" },
    ]),
    "A <a@example.com>; b@example.com",
  );
}

{
  const withCc = message({
    providerMessageId: "m1",
    sentAt: "2026-08-12T15:20:00.000Z",
    cc: [{ email: "cc@example.com", name: "Cc" }],
  });
  const lines = quoteHeaderLines(withCc, "Hello");
  assert.deepEqual(
    lines.map((l) => l.label),
    ["From", "Sent", "To", "Cc", "Subject"],
  );
  assert.equal(lines.find((l) => l.label === "Subject")?.value, "Hello");

  const noCc = message({
    providerMessageId: "m2",
    sentAt: "2026-08-12T15:20:00.000Z",
    cc: [],
  });
  assert.deepEqual(
    quoteHeaderLines(noCc, "Hello").map((l) => l.label),
    ["From", "Sent", "To", "Subject"],
  );
}

{
  const older = message({
    providerMessageId: "old",
    sentAt: "2026-08-10T10:00:00.000Z",
    bodyText: "older text body",
    snippet: "older snippet",
  });
  const newer = message({
    providerMessageId: "new",
    sentAt: "2026-08-11T10:00:00.000Z",
    from: { email: "evil@example.com", name: `Evil <script>alert(1)</script> "x"` },
    bodyHtml: "<p>newer html</p>",
  });
  const snippetOnly = message({
    providerMessageId: "snip",
    sentAt: "2026-08-09T10:00:00.000Z",
    bodyHtml: null,
    bodyText: null,
    snippet: "only snippet",
  });
  const conversation: Conversation = {
    providerConversationId: "c1",
    subject: "Thread subject",
    lastMessageAt: newer.sentAt,
    messages: [snippetOnly, older, newer],
  };

  const html = quotedThreadHtml(conversation);
  const newerIdx = html.indexOf("<p>newer html</p>");
  const olderIdx = html.indexOf("older text body");
  const snippetIdx = html.indexOf("only snippet");
  assert.ok(newerIdx >= 0 && olderIdx >= 0 && snippetIdx >= 0);
  assert.ok(newerIdx < olderIdx && olderIdx < snippetIdx, "newest first");
  assert.ok(!html.includes("<script>"), "hostile markup must be escaped in headers");
  assert.ok(html.includes(escapeHtml(`Evil <script>alert(1)</script> "x"`)));
  assert.match(html, /<pre>older text body<\/pre>/);
  assert.match(html, /<p>only snippet<\/p>/);
}

{
  const plain: Conversation = {
    providerConversationId: "c2",
    subject: "No files",
    lastMessageAt: "2026-08-12T12:00:00.000Z",
    messages: [
      message({
        providerMessageId: "m",
        sentAt: "2026-08-12T12:00:00.000Z",
        bodyHtml: "<p>original</p>",
      }),
    ],
  };
  assert.equal(hasAttachments(plain), false);
  const sent = gmailForwardHtml(plain, "<p>user note</p>");
  assert.ok(sent.startsWith("<p>user note</p>"));
  assert.ok(sent.includes("<p>original</p>"));
  assert.ok(sent.includes("seer-quote"));
  assert.ok(!sent.includes("Attachments from the original thread"));

  const withFile: Conversation = {
    ...plain,
    messages: [
      {
        ...plain.messages[0],
        attachments: [
          { id: "a1", filename: "a.pdf", mimeType: "application/pdf", sizeBytes: 10 },
        ],
      },
    ],
  };
  assert.equal(hasAttachments(withFile), true);
  const withNote = gmailForwardHtml(withFile, "<p>user note</p>");
  assert.ok(withNote.startsWith("<p>user note</p>"));
  assert.match(
    withNote,
    /Attachments from the original thread are not included in this forward/,
  );
  const noteIdx = withNote.indexOf("Attachments from the original");
  const quoteIdx = withNote.indexOf("seer-quote");
  assert.ok(noteIdx > 0 && noteIdx < quoteIdx);
}

console.log("v3-compose-quote: OK");
