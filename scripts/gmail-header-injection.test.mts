/**
 * Header injection in outbound Gmail MIME.
 *
 * Reply, reply-all, forward, and send build a raw RFC 822 document and join
 * header lines with CRLF. Subject and recipient values taken from a thread
 * the victim did not write are copied into those lines. A carriage return or
 * line feed in one of those values becomes a real header on the message
 * posted to Gmail's send method.
 *
 * These tests fail while that is true. Refusing the send before any request
 * is posted, or posting a message whose header lines contain neither the
 * break nor the extra recipient, makes them pass.
 */
import assert from "node:assert/strict";
import { GmailProvider } from "../src/lib/v2/providers/gmail.ts";
import { getGmailMessage, sendGmailMessage } from "../src/lib/mail/gmail.ts";

const HIDDEN = "hidden-recipient@example.com";
const VICTIM = "victim@example.com";
const ATTACKER = "attacker@example.com";
const COLLEAGUE = "colleague@example.com";
const NOTE = "<p>Private note only for the people shown in compose.</p>";
const HISTORY = "<p>Prior private history the victim did not retype.</p>";
const TOKEN = "placeholder-access-token";

type Sent = { url: string; body: string };

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function b64url(text: string): string {
  return Buffer.from(text, "utf8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function decodeRaw(requestBody: string): string {
  const raw = (JSON.parse(requestBody) as { raw?: string }).raw ?? "";
  assert.ok(raw, "messages/send was called without a raw message");
  const pad = raw.length % 4 === 0 ? "" : "=".repeat(4 - (raw.length % 4));
  return Buffer.from(raw.replace(/-/g, "+").replace(/_/g, "/") + pad, "base64").toString(
    "utf8",
  );
}

function headerLines(mime: string): string[] {
  const headerBlock = mime.split(/\r\n\r\n/, 1)[0] ?? "";
  return headerBlock.split(/\r?\n/).filter((line) => line.length > 0);
}

function addressTokens(line: string): string[] {
  const value = line.slice(line.indexOf(":") + 1);
  return value
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
}

/**
 * A posted message may only name the recipients the caller asked for.
 * A line break that introduces Bcc, or a recipient that is not one address,
 * fails.
 */
function assertNoHiddenRecipient(mime: string, allowed: string[]): void {
  const lines = headerLines(mime);
  const allowedSet = new Set(allowed.map((address) => address.toLowerCase()));
  for (const line of lines) {
    assert.equal(
      /\r|\n/.test(line),
      false,
      `header line still contains a line break:\n${JSON.stringify(line)}`,
    );
    assert.doesNotMatch(line, /^\s*bcc\s*:/i, `injected Bcc header:\n${mime}`);
  }
  const recipientLines = lines.filter((line) => /^(to|cc|bcc)\s*:/i.test(line));
  assert.ok(recipientLines.length > 0, "outbound message has no recipient header");
  for (const line of recipientLines) {
    for (const address of addressTokens(line)) {
      assert.match(
        address,
        /^[^\s<>@,;:"]+@[^\s<>@,;:"]+$/,
        `recipient is not a single address: ${JSON.stringify(address)}`,
      );
      assert.ok(
        allowedSet.has(address.toLowerCase()),
        `recipient ${address} was not one of ${[...allowedSet].join(", ")}`,
      );
      assert.notEqual(address.toLowerCase(), HIDDEN);
    }
  }
}

function gmailMessage(opts: {
  id: string;
  from: string;
  to?: string;
  cc?: string;
  subject: string;
  epoch: number;
  html?: string;
}) {
  return {
    id: opts.id,
    threadId: "thread-1",
    snippet: "snippet",
    labelIds: ["INBOX", "UNREAD"],
    internalDate: String(opts.epoch),
    payload: {
      mimeType: "text/html",
      headers: [
        { name: "From", value: opts.from },
        { name: "To", value: opts.to ?? VICTIM },
        { name: "Cc", value: opts.cc ?? "" },
        { name: "Subject", value: opts.subject },
        { name: "Message-ID", value: `<${opts.id}@example.com>` },
      ],
      body: { size: 1, data: b64url(opts.html ?? HISTORY) },
    },
  };
}

function providerFor(
  messages: ReturnType<typeof gmailMessage>[],
  sent: Sent[],
): GmailProvider {
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    const href = String(url);
    if (method === "GET" && href.includes("/threads/thread-1")) {
      return json({ id: "thread-1", messages });
    }
    if (method === "POST" && href.endsWith("/messages/send")) {
      sent.push({ url: href, body: String(init?.body ?? "") });
      return json({ id: "sent-1", threadId: "thread-1" });
    }
    throw new Error(`unexpected request ${method} ${href}`);
  }) as typeof fetch;
  return new GmailProvider({
    accessToken: TOKEN,
    accountEmail: VICTIM,
    fetchImpl,
  });
}

async function attempt(run: () => Promise<unknown>, sent: Sent[]): Promise<void> {
  try {
    await run();
  } catch {
    // Refusing before the send request is a fix. A request already recorded
    // is still checked below.
  }
  for (const call of sent) {
    assert.equal(
      call.url.endsWith("/messages/send"),
      true,
      "mail left the process through a request other than the send method",
    );
  }
}

let failures = 0;
async function check(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    console.log(`  ok   ${name}`);
  } catch (error) {
    failures += 1;
    console.error(`  FAIL ${name}`);
    console.error(error instanceof Error ? error.message : error);
  }
}

const breakForms = ["\r\n", "\n", "\r"] as const;

console.log("gmail header injection");

await check("reply with a clean thread does not add a recipient", async () => {
  const sent: Sent[] = [];
  const provider = providerFor(
    [
      gmailMessage({
        id: "m1",
        from: `Friendly <${ATTACKER}>`,
        subject: "Hello",
        epoch: 1_700_000_000_000,
      }),
    ],
    sent,
  );
  await provider.reply({ conversationId: "thread-1", all: false, bodyHtml: NOTE }, "k");
  assert.equal(sent.length, 1);
  assertNoHiddenRecipient(decodeRaw(sent[0].body), [ATTACKER]);
  assert.match(decodeRaw(sent[0].body), /Private note only for the people shown/);
});

for (const br of breakForms) {
  const label = JSON.stringify(br);

  await check(`reply subject ${label} adds no extra recipient`, async () => {
    const sent: Sent[] = [];
    const provider = providerFor(
      [
        gmailMessage({
          id: "m1",
          from: `Friendly Colleague <${ATTACKER}>`,
          subject: `Hello${br}Bcc: ${HIDDEN}`,
          epoch: 1_700_000_000_000,
          html: HISTORY,
        }),
      ],
      sent,
    );
    await attempt(
      () => provider.reply({ conversationId: "thread-1", all: false, bodyHtml: NOTE }, "k"),
      sent,
    );
    for (const call of sent) {
      const mime = decodeRaw(call.body);
      assertNoHiddenRecipient(mime, [ATTACKER]);
      assert.match(mime, /Private note only for the people shown/);
    }
  });

  await check(`reply From address ${label} adds no extra recipient`, async () => {
    const sent: Sent[] = [];
    const provider = providerFor(
      [
        gmailMessage({
          id: "older",
          from: `Earlier <earlier@example.com>`,
          subject: "Clean subject",
          epoch: 1_700_000_000_000,
          html: "<p>older</p>",
        }),
        gmailMessage({
          id: "latest",
          from: `Friendly Colleague <${ATTACKER}${br}Bcc: ${HIDDEN}>`,
          subject: "Clean subject",
          epoch: 1_700_000_100_000,
          html: HISTORY,
        }),
      ],
      sent,
    );
    await attempt(
      () => provider.reply({ conversationId: "thread-1", all: false, bodyHtml: NOTE }, "k"),
      sent,
    );
    for (const call of sent) {
      const mime = decodeRaw(call.body);
      assertNoHiddenRecipient(mime, [ATTACKER]);
      assert.match(mime, /Private note only for the people shown/);
    }
  });

  await check(`reply-all Cc address ${label} adds no extra recipient`, async () => {
    const sent: Sent[] = [];
    const provider = providerFor(
      [
        gmailMessage({
          id: "m1",
          from: ATTACKER,
          to: VICTIM,
          cc: `ally@example.com${br}Bcc: ${HIDDEN}`,
          subject: "Clean subject",
          epoch: 1_700_000_000_000,
        }),
      ],
      sent,
    );
    await attempt(
      () => provider.reply({ conversationId: "thread-1", all: true, bodyHtml: NOTE }, "k"),
      sent,
    );
    for (const call of sent) {
      assertNoHiddenRecipient(decodeRaw(call.body), [ATTACKER, "ally@example.com"]);
    }
  });

  await check(`forward subject ${label} adds no extra recipient and keeps the quote`, async () => {
    const sent: Sent[] = [];
    const provider = providerFor(
      [
        gmailMessage({
          id: "m1",
          from: `Friendly Colleague <${ATTACKER}>`,
          subject: `Hello${br}Bcc: ${HIDDEN}`,
          epoch: 1_700_000_000_000,
          html: HISTORY,
        }),
      ],
      sent,
    );
    await attempt(
      () =>
        provider.forward(
          {
            conversationId: "thread-1",
            to: [{ email: COLLEAGUE }],
            bodyHtml: NOTE,
          },
          "k",
        ),
      sent,
    );
    for (const call of sent) {
      const mime = decodeRaw(call.body);
      assertNoHiddenRecipient(mime, [COLLEAGUE]);
      assert.match(mime, /Private note only for the people shown/);
      assert.match(mime, /Prior private history the victim did not retype/);
    }
  });

  await check(`send subject and recipients ${label} add no extra recipient`, async () => {
    const sent: Sent[] = [];
    const provider = providerFor([], sent);
    await attempt(
      () =>
        provider.send(
          {
            to: [{ email: `${COLLEAGUE}${br}Bcc: ${HIDDEN}` }],
            cc: [{ email: `ally@example.com${br}Bcc: ${HIDDEN}` }],
            subject: `Hello${br}Bcc: ${HIDDEN}`,
            bodyHtml: NOTE,
          },
          "k",
        ),
      sent,
    );
    for (const call of sent) {
      assertNoHiddenRecipient(decodeRaw(call.body), [COLLEAGUE, "ally@example.com"]);
    }
  });
}

function v1Fetch(message: ReturnType<typeof gmailMessage>, sent: Sent[]): typeof fetch {
  return (async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    const href = String(url);
    if (method === "GET" && href.includes("/messages/m1")) {
      return json(message);
    }
    if (method === "POST" && href.endsWith("/messages/send")) {
      sent.push({ url: href, body: String(init?.body ?? "") });
      return json({ id: "sent-1", threadId: "thread-1" });
    }
    return new Response("unexpected", { status: 500 });
  }) as typeof fetch;
}

for (const br of breakForms) {
  const label = JSON.stringify(br);

  await check(`legacy send subject, To, Cc, and In-Reply-To ${label} add no extra recipient`, async () => {
    const sent: Sent[] = [];
    const previous = globalThis.fetch;
    globalThis.fetch = v1Fetch(
      gmailMessage({
        id: "m1",
        from: `Friendly Colleague <${ATTACKER}${br}Bcc: ${HIDDEN}>`,
        cc: `ally@example.com${br}Bcc: ${HIDDEN}`,
        subject: `Hello${br}Bcc: ${HIDDEN}`,
        epoch: 1_700_000_000_000,
        html: HISTORY,
      }),
      sent,
    );
    try {
      const original = await getGmailMessage(TOKEN, "m1");
      const subject = /^re:/i.test(original.subject) ? original.subject : `Re: ${original.subject}`;
      try {
        await sendGmailMessage(TOKEN, {
          to: original.fromEmail,
          cc: original.ccEmail,
          subject,
          body: "Private note only for the people shown in compose.",
          html: NOTE,
          threadId: original.threadId,
          inReplyTo: `${original.messageIdHeader}${br}Bcc: ${HIDDEN}`,
          references: original.messageIdHeader,
        });
      } catch {
        // Refusal before the send request is a fix.
      }
    } finally {
      globalThis.fetch = previous;
    }
    for (const call of sent) {
      assertNoHiddenRecipient(decodeRaw(call.body), [ATTACKER, "ally@example.com"]);
    }
  });

  await check(`legacy forward subject ${label} adds no extra recipient`, async () => {
    const sent: Sent[] = [];
    const previous = globalThis.fetch;
    globalThis.fetch = v1Fetch(
      gmailMessage({
        id: "m1",
        from: `Friendly Colleague <${ATTACKER}>`,
        subject: `Hello${br}Bcc: ${HIDDEN}`,
        epoch: 1_700_000_000_000,
        html: HISTORY,
      }),
      sent,
    );
    try {
      const original = await getGmailMessage(TOKEN, "m1");
      const subject = /^(fwd|fw):/i.test(original.subject)
        ? original.subject
        : `Fwd: ${original.subject}`;
      const quoted = `${NOTE}\n\nFrom: ${original.fromName} <${original.fromEmail}>\nSubject: ${original.subject}\n\n${original.textBody || original.htmlBody}`;
      try {
        await sendGmailMessage(TOKEN, {
          to: COLLEAGUE,
          subject,
          body: quoted,
          html: NOTE,
        });
      } catch {
        // Refusal before the send request is a fix.
      }
    } finally {
      globalThis.fetch = previous;
    }
    for (const call of sent) {
      const mime = decodeRaw(call.body);
      assertNoHiddenRecipient(mime, [COLLEAGUE]);
      assert.match(mime, /Prior private history the victim did not retype/);
    }
  });
}

if (failures > 0) {
  console.error(`\n${failures} header-injection check(s) failed`);
  process.exit(1);
}
console.log("\nall header-injection checks passed");
