/**
 * Spec for the legacy and v2 Gmail MIME walks.
 *
 * These tests fail while a multipart tree nested past the JavaScript call
 * stack rejects the message that contains it. They pass once each walk is
 * bounded (depth and part count) and still returns every part that fits,
 * including the other messages in the same thread.
 *
 * Run: npx tsx scripts/gmail-mime-recursion.test.mts
 *
 * Covered walks:
 * - src/lib/mail/gmail.ts extractBodies, via getGmailMessage and
 *   getGmailThreadMessages (the sequence used by GET /api/messages/[id])
 * - src/lib/v2/providers/gmail.ts walkBodies, via getConversation, search,
 *   syncFolder, reply, forward, and getAttachment
 *
 * Not the same bug, so not asserted to fail here:
 * - Microsoft Graph has no recursive MIME-part walk.
 * - mutateConversation and moveConversation download a thread but do not walk
 *   parts. mutateConversation is asserted to keep working.
 * - send, delegate, assist draft, mailbox, today, alltasks, and cron sync call
 *   getGmailMessage and no second walker. Their MIME behavior is the
 *   getGmailMessage cases below; their auth and model calls are not invoked.
 */
import assert from "node:assert/strict";
import { getGmailMessage, getGmailThreadMessages } from "../src/lib/mail/gmail.ts";
import { GmailProvider } from "../src/lib/v2/providers/gmail.ts";

const TOKEN = "test-access-token";
const ACCOUNT = "me@example.com";

/** Deep enough to pass any stack this runtime will give a recursive walk. */
const HOSTILE_DEPTH = 20_000;
/** Far below the stack limit, and deeper than a normal forward chain. */
const PRESERVED_DEPTH = 32;

function b64url(text: string): string {
  return Buffer.from(text, "utf8").toString("base64url");
}

function nestedContainers(depth: number, leafJson: string): string {
  let json = leafJson;
  for (let i = 0; i < depth; i++) {
    json = `{"mimeType":"multipart/mixed","parts":[${json}]}`;
  }
  return json;
}

function withPayload(message: Record<string, unknown>, payloadJson: string): string {
  const head = JSON.stringify(message);
  return `${head.slice(0, -1)},"payload":${payloadJson}}`;
}

function textPart(text: string): string {
  return JSON.stringify({
    mimeType: "text/plain",
    body: { data: b64url(text), size: text.length },
  });
}

function attachmentPart(id: string, filename: string): string {
  return JSON.stringify({
    filename,
    mimeType: "text/plain",
    body: { attachmentId: id, size: 4 },
  });
}

const buriedLeaf = textPart("buried-leaf");

function hostilePayloadJson(): string {
  const headers = JSON.stringify([
    { name: "From", value: "Attacker <attacker@example.com>" },
    { name: "To", value: ACCOUNT },
    { name: "Cc", value: "cc@example.com" },
    { name: "Subject", value: "Nested" },
    { name: "Message-ID", value: "<nested@example.com>" },
  ]);
  const parts = [
    textPart("shallow sibling"),
    attachmentPart("att-side", "side.txt"),
    nestedContainers(HOSTILE_DEPTH, buriedLeaf),
  ].join(",");
  return `{"mimeType":"multipart/mixed","headers":${headers},"parts":[${parts}]}`;
}

function chainPayloadJson(depth: number, leaf: string, subject: string): string {
  const headers = JSON.stringify([
    { name: "From", value: "Friend <friend@example.com>" },
    { name: "To", value: ACCOUNT },
    { name: "Subject", value: subject },
    { name: "Message-ID", value: "<chain@example.com>" },
  ]);
  return `{"mimeType":"multipart/mixed","headers":${headers},"parts":[${nestedContainers(depth, textPart(leaf))}]}`;
}

function ordinaryPayload() {
  return {
    mimeType: "multipart/mixed",
    headers: [
      { name: "From", value: "Friend <friend@example.com>" },
      { name: "To", value: ACCOUNT },
      { name: "Cc", value: "cc@example.com" },
      { name: "Subject", value: "Ordinary" },
      { name: "Message-ID", value: "<ordinary@example.com>" },
    ],
    parts: [
      {
        mimeType: "multipart/alternative",
        parts: [
          { mimeType: "text/plain", body: { data: b64url("other message body"), size: 18 } },
          { mimeType: "text/html", body: { data: b64url("<p>other html</p>"), size: 16 } },
          {
            mimeType: "text/calendar",
            body: {
              data: b64url("BEGIN:VCALENDAR\r\nUID:invite-42\r\nEND:VCALENDAR\r\n"),
              size: 48,
            },
          },
        ],
      },
      {
        filename: "notes.txt",
        mimeType: "text/plain",
        body: { attachmentId: "att-notes", size: 3 },
      },
    ],
  };
}

function ordinaryMessage(id: string, threadId: string, internalDate: string) {
  return {
    id,
    threadId,
    snippet: "plain snippet",
    internalDate,
    labelIds: ["INBOX", "UNREAD"],
    payload: ordinaryPayload(),
  };
}

function hostileMessageJson(id: string, threadId: string, internalDate: string): string {
  return withPayload(
    {
      id,
      threadId,
      snippet: "nested snippet",
      internalDate,
      labelIds: ["INBOX"],
    },
    hostilePayloadJson(),
  );
}

function chainMessageJson(
  id: string,
  threadId: string,
  internalDate: string,
  depth: number,
  leaf: string,
): string {
  return withPayload(
    {
      id,
      threadId,
      snippet: "chain snippet",
      internalDate,
      labelIds: ["INBOX"],
    },
    chainPayloadJson(depth, leaf, "Chain"),
  );
}

const PLAIN_ID = "plain";
const NESTED_ID = "nested";
const CHAIN_ID = "chain";
const THREAD_ID = "thread-1";
const CHAIN_THREAD_ID = "thread-chain";
const PLAIN_THREAD_ID = "thread-plain";

const plainRecord = ordinaryMessage(PLAIN_ID, THREAD_ID, "1600000000000");
const nestedRecordJson = hostileMessageJson(NESTED_ID, THREAD_ID, "1600000005000");
const chainRecordJson = chainMessageJson(
  CHAIN_ID,
  CHAIN_THREAD_ID,
  "1600000001000",
  PRESERVED_DEPTH,
  "thirty-two-deep",
);
const plainOnlyRecord = ordinaryMessage(PLAIN_ID, PLAIN_THREAD_ID, "1600000000000");

function jsonResponse(body: string): Response {
  return new Response(body, {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function threadResponse(id: string, messageBodies: string[]): string {
  return `{"id":${JSON.stringify(id)},"messages":[${messageBodies.join(",")}]}`;
}

type Route = { url: string; method: string };

function routeOf(input: RequestInfo | URL, init?: RequestInit): Route {
  return {
    url: typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url,
    method: (init?.method ?? "GET").toUpperCase(),
  };
}

let sends = 0;
let modifies = 0;

const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const { url, method } = routeOf(input, init);
  const parsed = new URL(url);
  const path = parsed.pathname;

  if (method === "GET" && path.endsWith("/threads")) {
    const q = parsed.searchParams.get("q") ?? "";
    if (q.includes("in:inbox") || q === "budget") {
      return jsonResponse(
        JSON.stringify({
          threads: [{ id: THREAD_ID }, { id: PLAIN_THREAD_ID }],
          resultSizeEstimate: 2,
        }),
      );
    }
  }

  const threadGet = path.match(/\/threads\/([^/]+)$/);
  if (method === "GET" && threadGet) {
    const id = decodeURIComponent(threadGet[1]);
    const format = parsed.searchParams.get("format");
    if (format === "minimal") {
      assert.equal(id, THREAD_ID);
      return jsonResponse(
        JSON.stringify({ id, messages: [{ id: NESTED_ID }, { id: PLAIN_ID }] }),
      );
    }
    if (id === THREAD_ID) {
      return jsonResponse(threadResponse(id, [nestedRecordJson, JSON.stringify(plainRecord)]));
    }
    if (id === CHAIN_THREAD_ID) return jsonResponse(threadResponse(id, [chainRecordJson]));
    if (id === PLAIN_THREAD_ID) {
      return jsonResponse(threadResponse(id, [JSON.stringify(plainOnlyRecord)]));
    }
  }

  const attachmentGet = path.match(/\/messages\/([^/]+)\/attachments\/([^/]+)$/);
  if (method === "GET" && attachmentGet) {
    assert.equal(decodeURIComponent(attachmentGet[2]), "att-side");
    return jsonResponse(JSON.stringify({ data: b64url("file") }));
  }

  const messageGet = path.match(/\/messages\/([^/]+)$/);
  if (method === "GET" && messageGet) {
    const id = decodeURIComponent(messageGet[1]);
    if (id === PLAIN_ID) return jsonResponse(JSON.stringify(plainRecord));
    if (id === NESTED_ID) return jsonResponse(nestedRecordJson);
    if (id === CHAIN_ID) return jsonResponse(chainRecordJson);
  }

  if (method === "POST" && path.endsWith("/messages/send")) {
    sends += 1;
    return jsonResponse(JSON.stringify({ id: "sent-1", threadId: THREAD_ID }));
  }

  const modify = path.match(/\/messages\/([^/]+)\/modify$/);
  if (method === "POST" && modify) {
    modifies += 1;
    return jsonResponse(JSON.stringify({ id: decodeURIComponent(modify[1]) }));
  }

  throw new Error(`unexpected ${method} ${url}`);
}) as typeof fetch;

function provider(): GmailProvider {
  return new GmailProvider({
    accessToken: TOKEN,
    accountEmail: ACCOUNT,
    fetchImpl,
  });
}

const failures: string[] = [];

async function test(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    console.log(`ok  ${name}`);
  } catch (err) {
    failures.push(name);
    console.error(`FAIL ${name}`);
    console.error(err instanceof Error ? `${err.name}: ${err.message}` : err);
  }
}

async function main() {
  const previous = globalThis.fetch;
  globalThis.fetch = fetchImpl;
  try {
    await test("ordinary multipart still yields text, html, calendar, and attachments", async () => {
      const message = await getGmailMessage(TOKEN, PLAIN_ID);
      assert.equal(message.subject, "Ordinary");
      assert.equal(message.fromEmail, "friend@example.com");
      assert.equal(message.textBody, "other message body");
      assert.equal(message.htmlBody, "<p>other html</p>");
      assert.equal(message.icalUid, "invite-42");
      assert.equal(message.attachments[0]?.id, "att-notes");
      assert.equal(message.attachments[0]?.filename, "notes.txt");
    });

    await test("a 32-level multipart still returns the leaf text", async () => {
      const message = await getGmailMessage(TOKEN, CHAIN_ID);
      assert.equal(message.textBody, "thirty-two-deep");
      assert.equal(message.subject, "Chain");
    });

    await test("opening the nested message returns its in-limit parts", async () => {
      const message = await getGmailMessage(TOKEN, NESTED_ID);
      assert.equal(message.subject, "Nested");
      assert.equal(message.fromEmail, "attacker@example.com");
      assert.match(message.textBody, /shallow sibling/);
      assert.ok(message.attachments.some((attachment) => attachment.id === "att-side"));
    });

    await test("a nested message does not reject the rest of the thread", async () => {
      const opened = await getGmailMessage(TOKEN, PLAIN_ID);
      const thread = await getGmailThreadMessages(TOKEN, opened.threadId);
      const plain = thread.find((message) => message.id === PLAIN_ID);
      const nested = thread.find((message) => message.id === NESTED_ID);
      assert.ok(plain);
      assert.equal(plain.textBody, "other message body");
      assert.equal(plain.htmlBody, "<p>other html</p>");
      assert.equal(plain.icalUid, "invite-42");
      assert.equal(plain.attachments[0]?.id, "att-notes");
      assert.ok(nested);
      assert.match(nested.textBody, /shallow sibling/);
      assert.equal(nested.subject, "Nested");
    });

    await test("opening the nested message still returns the other message in the thread", async () => {
      const opened = await getGmailMessage(TOKEN, NESTED_ID);
      const thread = await getGmailThreadMessages(TOKEN, opened.threadId);
      const plain = thread.find((message) => message.id === PLAIN_ID);
      assert.ok(plain);
      assert.equal(plain.textBody, "other message body");
      assert.equal(plain.fromEmail, "friend@example.com");
    });

    await test("v2 conversation keeps both the nested message and its neighbor", async () => {
      const conversation = await provider().getConversation(THREAD_ID);
      const plain = conversation.messages.find((message) => message.providerMessageId === PLAIN_ID);
      const nested = conversation.messages.find((message) => message.providerMessageId === NESTED_ID);
      assert.equal(conversation.subject, "Nested");
      assert.ok(plain);
      assert.equal(plain.bodyText, "other message body");
      assert.equal(plain.bodyHtml, "<p>other html</p>");
      assert.equal(plain.attachments[0]?.id, "att-notes");
      assert.ok(nested);
      assert.equal(nested.bodyText, "shallow sibling");
      assert.ok(nested.attachments.some((attachment) => attachment.id === "att-side"));
    });

    await test("v2 preserves a 32-level leaf", async () => {
      const conversation = await provider().getConversation(CHAIN_THREAD_ID);
      assert.equal(conversation.messages[0]?.bodyText, "thirty-two-deep");
    });

    await test("v2 search returns the plain thread when another thread is nested", async () => {
      const result = await provider().search("budget");
      const plain = result.conversations.find(
        (conversation) => conversation.providerConversationId === PLAIN_THREAD_ID,
      );
      const nested = result.conversations.find(
        (conversation) => conversation.providerConversationId === THREAD_ID,
      );
      assert.ok(plain);
      assert.equal(plain.messages[0]?.bodyText, "other message body");
      assert.ok(nested);
      assert.equal(
        nested.messages.find((message) => message.providerMessageId === NESTED_ID)?.bodyText,
        "shallow sibling",
      );
    });

    await test("v2 inbox sync returns the plain thread when another thread is nested", async () => {
      const page = await provider().syncFolder("inbox");
      const plain = page.conversations.find(
        (conversation) => conversation.providerConversationId === PLAIN_THREAD_ID,
      );
      const nested = page.conversations.find(
        (conversation) => conversation.providerConversationId === THREAD_ID,
      );
      assert.ok(plain);
      assert.equal(plain.messages[0]?.bodyText, "other message body");
      assert.ok(nested);
      assert.match(
        nested.messages.find((message) => message.providerMessageId === NESTED_ID)?.bodyText ?? "",
        /shallow sibling/,
      );
    });

    await test("v2 attachment download still finds a sibling of a nested branch", async () => {
      const content = await provider().getAttachment(NESTED_ID, "att-side");
      assert.equal(content.filename, "side.txt");
      assert.equal(content.body.toString("utf8"), "file");
    });

    await test("v2 reply still sends when the thread contains a nested message", async () => {
      sends = 0;
      const receipt = await provider().reply(
        { conversationId: THREAD_ID, all: false, bodyHtml: "<p>reply</p>" },
        "reply-key",
      );
      assert.equal(sends, 1);
      assert.equal(receipt.providerMessageId, "sent-1");
    });

    await test("v2 forward still sends when the thread contains a nested message", async () => {
      sends = 0;
      const receipt = await provider().forward(
        {
          conversationId: THREAD_ID,
          to: [{ email: "other@example.com" }],
          bodyHtml: "<p>forward</p>",
        },
        "forward-key",
      );
      assert.equal(sends, 1);
      assert.equal(receipt.providerMessageId, "sent-1");
    });

    await test("archiving a nested thread does not walk parts and still completes", async () => {
      modifies = 0;
      const receipt = await provider().mutateConversation(THREAD_ID, "archive", "archive-key");
      assert.equal(modifies, 2);
      assert.deepEqual(receipt.processed.sort(), [NESTED_ID, PLAIN_ID].sort());
      assert.deepEqual(receipt.failed, []);
    });
  } finally {
    globalThis.fetch = previous;
  }

  if (failures.length > 0) {
    console.error(`\n${failures.length} failed`);
    process.exit(1);
  }
  console.log("\ngmail-mime-recursion: OK");
}

await main();
