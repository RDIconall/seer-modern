import assert from "node:assert/strict";
import { sendGraphMessage, replyGraphMessage } from "../src/lib/mail/graph.ts";
import { sendGmailMessage } from "../src/lib/mail/gmail.ts";

let failures = 0;
async function check(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    console.log(`  ok   ${name}`);
  } catch (e) {
    failures += 1;
    console.error(`  FAIL ${name}\n       ${e instanceof Error ? e.message : e}`);
  }
}

/** Stand in for the provider, answering with a chosen status and body. */
function stubFetch(status: number, body: string) {
  const calls: { url: string; body?: string }[] = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), body: init?.body as string | undefined });
    return new Response(body || null, { status });
  }) as typeof fetch;
  return calls;
}

/** The MIME Gmail was handed, back out of the base64url `raw` field. */
function sentMime(calls: { body?: string }[]): string {
  const raw = (JSON.parse(calls.at(-1)?.body ?? "{}") as { raw?: string }).raw;
  assert.ok(raw, "no raw MIME was sent");
  return Buffer.from(raw.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString(
    "utf8",
  );
}

console.log("mail send");

await check(
  "Graph sendMail answering 202 with no body is a success, not a parse error",
  async () => {
    stubFetch(202, "");
    await sendGraphMessage("token", {
      to: "someone@example.com",
      subject: "Hello",
      body: "Hi",
    });
  },
);

await check("Graph reply answering 202 with no body succeeds", async () => {
  stubFetch(202, "");
  await replyGraphMessage("token", "msg-1", "Thanks", false);
});

await check("Graph still reports a real failure", async () => {
  stubFetch(400, JSON.stringify({ error: { message: "Invalid recipient" } }));
  await assert.rejects(() =>
    sendGraphMessage("token", {
      to: "nope",
      subject: "Hello",
      body: "Hi",
    }),
  );
});

await check("Gmail send tolerates an empty success body", async () => {
  stubFetch(200, "");
  const sent = await sendGmailMessage("token", {
    to: "someone@example.com",
    subject: "Hello",
    body: "Hi",
    threadId: "t1",
  });
  assert.equal(sent.threadId, "t1");
});

await check("Gmail send returns the ids it is given", async () => {
  stubFetch(200, JSON.stringify({ id: "m1", threadId: "t9" }));
  const sent = await sendGmailMessage("token", {
    to: "someone@example.com",
    subject: "Hello",
    body: "Hi",
  });
  assert.deepEqual(sent, { id: "m1", threadId: "t9" });
});

// Multipart is the one piece of the send path that fails silently: a bad
// boundary looks right in Sent and arrives as raw MIME.
await check("a plain send stays single-part text/plain", async () => {
  const calls = stubFetch(200, JSON.stringify({ id: "m1", threadId: "t1" }));
  await sendGmailMessage("token", {
    to: "someone@example.com",
    subject: "Hello",
    body: "Hi",
  });
  const mime = sentMime(calls);
  assert.match(mime, /^Content-Type: text\/plain; charset="UTF-8"$/m);
  assert.ok(!mime.includes("multipart/alternative"));
  assert.ok(mime.endsWith("\r\n\r\nHi"), "the body is the last thing sent");
});

await check("a rich send is multipart, text first, HTML second", async () => {
  const calls = stubFetch(200, JSON.stringify({ id: "m1", threadId: "t1" }));
  await sendGmailMessage("token", {
    to: "someone@example.com",
    subject: "Hello",
    body: "- one\n- two",
    html: "<ul><li>one</li><li>two</li></ul>",
  });
  const mime = sentMime(calls);

  const boundary = mime.match(/boundary="([^"]+)"/)?.[1];
  assert.ok(boundary, "no boundary declared");
  // Every part opens with --boundary and the message closes with --boundary--
  const opens = mime.split(`\r\n--${boundary}\r\n`).length - 1;
  assert.equal(opens, 2, "expected exactly two parts");
  assert.ok(mime.endsWith(`\r\n--${boundary}--`), "unterminated multipart");

  const textAt = mime.indexOf('Content-Type: text/plain; charset="UTF-8"');
  const htmlAt = mime.indexOf('Content-Type: text/html; charset="UTF-8"');
  assert.ok(textAt > 0 && htmlAt > 0, "both parts must be typed");
  assert.ok(textAt < htmlAt, "text must precede HTML for the fallback to work");
  assert.ok(mime.includes("- one\n- two"));
  assert.ok(mime.includes("<ul><li>one</li><li>two</li></ul>"));
  // The multipart header replaces the single-part one, never joins it.
  assert.ok(
    !/^MIME-Version: 1\.0\r\nContent-Type: text\/plain/m.test(mime),
    "a stray top-level text/plain header would hide both parts",
  );
});

await check("Graph sends HTML when it is given, Text when it is not", async () => {
  let calls = stubFetch(202, "");
  await sendGraphMessage("token", {
    to: "someone@example.com",
    subject: "Hello",
    body: "- one",
    html: "<ul><li>one</li></ul>",
  });
  let payload = JSON.parse(calls.at(-1)?.body ?? "{}") as {
    message?: { body?: { contentType?: string; content?: string } };
  };
  assert.equal(payload.message?.body?.contentType, "HTML");
  assert.equal(payload.message?.body?.content, "<ul><li>one</li></ul>");

  calls = stubFetch(202, "");
  await sendGraphMessage("token", {
    to: "someone@example.com",
    subject: "Hello",
    body: "- one",
  });
  payload = JSON.parse(calls.at(-1)?.body ?? "{}");
  assert.equal(payload.message?.body?.contentType, "Text");
  assert.equal(payload.message?.body?.content, "- one");
});

if (failures) {
  console.error(`\n${failures} failed`);
  process.exit(1);
}
console.log("\nall passed");
