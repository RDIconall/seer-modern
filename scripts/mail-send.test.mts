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
  const calls: { url: string }[] = [];
  globalThis.fetch = (async (input: string | URL | Request) => {
    calls.push({ url: String(input) });
    return new Response(body || null, { status });
  }) as typeof fetch;
  return calls;
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

if (failures) {
  console.error(`\n${failures} failed`);
  process.exit(1);
}
console.log("\nall passed");
