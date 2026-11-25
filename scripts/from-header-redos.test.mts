/**
 * Legacy Gmail address parsing must stay bounded on a From/To/Cc value an
 * outside sender can put on a message.
 *
 * The header under test is a quoted display name of alternating at-signs and
 * spaces, a normal angle-addr, and a trailing comment. It is anchored so the
 * comment makes the match fail, and the failure is what sends the matcher
 * back through every space and every at-sign. These assertions fail while
 * that matcher is still in place.
 */
import assert from "node:assert/strict";
import {
  getGmailMessage,
  getGmailThreadLast,
  getGmailThreadMessages,
  listGmailFolder,
  listGmailInbox,
  searchGmail,
} from "../src/lib/mail/gmail.ts";
import { GmailProvider } from "../src/lib/v2/providers/gmail.ts";

const TOKEN = "placeholder-access-token";
const BUDGET_MS = 500;
/** Long enough that the nested quantifiers take seconds on this runtime. */
const PAIRS = 2000;

function hostileAddress(pairs = PAIRS): string {
  return `"${"@ ".repeat(pairs)}" <sender@example.com> (note)`;
}

function foldedHostileAddress(): string {
  const left = "@ ".repeat(PAIRS / 2);
  const right = "@ ".repeat(PAIRS / 2);
  return `"${left}\r\n ${right}" <sender@example.com> (note)`;
}

function b64url(text: string): string {
  return Buffer.from(text, "utf8").toString("base64url");
}

function fullMessage(id: string, from: string, to = "Victim <victim@example.com>", cc = "") {
  return {
    id,
    threadId: "thread-1",
    snippet: "hello",
    internalDate: "1600000000000",
    labelIds: ["INBOX", "UNREAD"],
    payload: {
      mimeType: "text/plain",
      headers: [
        { name: "From", value: from },
        { name: "To", value: to },
        { name: "Cc", value: cc },
        { name: "Subject", value: "Hello" },
        { name: "Message-ID", value: "<m@example.com>" },
      ],
      body: { size: 4, data: b64url("body") },
    },
  };
}

function metadataMessage(
  id: string,
  from: string,
  to = "Victim <victim@example.com>",
  cc = "",
) {
  return {
    id,
    threadId: "thread-1",
    snippet: "hello",
    internalDate: "1600000000000",
    labelIds: ["INBOX"],
    payload: {
      headers: [
        { name: "From", value: from },
        { name: "To", value: to },
        { name: "Cc", value: cc },
        { name: "Subject", value: "Hello" },
      ],
    },
  };
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

async function withGmail(
  handler: (url: string) => unknown,
  run: () => Promise<void>,
): Promise<void> {
  const previous = globalThis.fetch;
  globalThis.fetch = async (input: RequestInfo | URL) => {
    const url = String(input);
    assert.ok(
      url.startsWith("https://gmail.googleapis.com/gmail/v1/"),
      `unexpected host ${url}`,
    );
    return jsonResponse(handler(url));
  };
  try {
    await run();
  } finally {
    globalThis.fetch = previous;
  }
}

const failures: string[] = [];

async function expectBounded(
  name: string,
  run: () => Promise<void>,
): Promise<void> {
  const start = performance.now();
  try {
    await run();
  } catch (error) {
    const ms = performance.now() - start;
    failures.push(
      `${name} rejected after ${Math.round(ms)}ms: ${error instanceof Error ? error.message : String(error)}`,
    );
    return;
  }
  const ms = performance.now() - start;
  if (ms >= BUDGET_MS) {
    failures.push(
      `${name} blocked for ${Math.round(ms)}ms (budget ${BUDGET_MS}ms)`,
    );
  }
}

async function benignAddressesParse(): Promise<void> {
  await withGmail(
    (url) => {
      if (url.includes("/users/me/messages/msg-quoted?format=full")) {
        return fullMessage("msg-quoted", '"Ada Lovelace" <ada@example.com>');
      }
      if (url.includes("/users/me/messages/msg-bare?format=full")) {
        return fullMessage("msg-bare", "ada@example.com");
      }
      if (url.includes("/users/me/messages/msg-named?format=full")) {
        return fullMessage("msg-named", "Ada Lovelace <ada@example.com>");
      }
      throw new Error(`unexpected benign fetch ${url}`);
    },
    async () => {
      const quoted = await getGmailMessage(TOKEN, "msg-quoted");
      assert.equal(quoted.fromName, "Ada Lovelace");
      assert.equal(quoted.fromEmail, "ada@example.com");

      const bare = await getGmailMessage(TOKEN, "msg-bare");
      assert.equal(bare.fromEmail, "ada@example.com");

      const named = await getGmailMessage(TOKEN, "msg-named");
      assert.equal(named.fromName, "Ada Lovelace");
      assert.equal(named.fromEmail, "ada@example.com");
    },
  );
}

async function currentAdapterStaysFast(): Promise<void> {
  const from = hostileAddress();
  const provider = new GmailProvider({
    accessToken: TOKEN,
    accountEmail: "victim@example.com",
    fetchImpl: async (input) => {
      const url = String(input);
      assert.ok(url.includes("/threads/thread-1?format=full"));
      return jsonResponse({
        id: "thread-1",
        messages: [
          {
            id: "msg-hostile",
            threadId: "thread-1",
            snippet: "hello",
            labelIds: ["INBOX", "UNREAD"],
            internalDate: "1600000000000",
            payload: {
              mimeType: "text/plain",
              headers: [
                { name: "From", value: from },
                { name: "To", value: "Victim <victim@example.com>" },
                { name: "Subject", value: "Hello" },
              ],
              body: { size: 4, data: b64url("body") },
            },
          },
        ],
      });
    },
  });
  const start = performance.now();
  const conversation = await provider.getConversation("thread-1");
  const ms = performance.now() - start;
  assert.equal(conversation.messages.length, 1);
  assert.equal(conversation.messages[0]?.providerMessageId, "msg-hostile");
  assert.ok(ms < BUDGET_MS, `current adapter took ${Math.round(ms)}ms`);
}

async function draftLoaderOnHostileFrom(): Promise<void> {
  let fetched = false;
  await withGmail(
    (url) => {
      assert.ok(url.includes("/users/me/messages/msg-hostile?format=full"));
      fetched = true;
      return fullMessage("msg-hostile", hostileAddress());
    },
    async () => {
      await expectBounded(
        "getGmailMessage hostile From (draft/reader/send loader)",
        async () => {
          const message = await getGmailMessage(TOKEN, "msg-hostile");
          assert.equal(message.id, "msg-hostile");
        },
      );
    },
  );
  assert.equal(fetched, true, "getGmailMessage never requested the message");
}

async function draftLoaderOnFoldedFrom(): Promise<void> {
  let fetched = false;
  await withGmail(
    (url) => {
      assert.ok(url.includes("/users/me/messages/msg-folded?format=full"));
      fetched = true;
      return fullMessage("msg-folded", foldedHostileAddress());
    },
    async () => {
      await expectBounded("getGmailMessage folded hostile From", async () => {
        const message = await getGmailMessage(TOKEN, "msg-folded");
        assert.equal(message.id, "msg-folded");
      });
    },
  );
  assert.equal(fetched, true, "folded From was never fetched");
}

async function listHydratesHostileFrom(): Promise<void> {
  let hydrated = false;
  await withGmail(
    (url) => {
      if (url.includes("/users/me/messages?")) {
        return { messages: [{ id: "msg-list", threadId: "thread-1" }] };
      }
      assert.ok(url.includes("/users/me/messages/msg-list?format=metadata"));
      hydrated = true;
      return metadataMessage("msg-list", hostileAddress());
    },
    async () => {
      await expectBounded("listGmailFolder hostile From", async () => {
        const items = await listGmailFolder(TOKEN, "inbox", 10);
        assert.equal(items.length, 1);
        assert.equal(items[0]?.id, "msg-list");
      });
    },
  );
  assert.equal(hydrated, true, "list hydration never loaded the message");
}

async function inboxListHydratesHostileTo(): Promise<void> {
  let hydrated = false;
  await withGmail(
    (url) => {
      if (url.includes("/users/me/messages?")) {
        return { messages: [{ id: "msg-to", threadId: "thread-1" }] };
      }
      hydrated = true;
      return metadataMessage(
        "msg-to",
        "Sender <sender@example.com>",
        hostileAddress(),
      );
    },
    async () => {
      await expectBounded("listGmailInbox hostile To", async () => {
        const items = await listGmailInbox(TOKEN, 10);
        assert.equal(items.length, 1);
        assert.equal(items[0]?.id, "msg-to");
      });
    },
  );
  assert.equal(hydrated, true, "inbox list never loaded the message");
}

async function searchHydratesHostileCc(): Promise<void> {
  let hydrated = false;
  await withGmail(
    (url) => {
      if (url.includes("/users/me/messages?")) {
        return { messages: [{ id: "msg-cc", threadId: "thread-1" }] };
      }
      hydrated = true;
      return metadataMessage(
        "msg-cc",
        "Sender <sender@example.com>",
        "Victim <victim@example.com>",
        hostileAddress(),
      );
    },
    async () => {
      await expectBounded("searchGmail hostile Cc", async () => {
        const items = await searchGmail(TOKEN, "hello", 10);
        assert.equal(items.length, 1);
        assert.equal(items[0]?.id, "msg-cc");
      });
    },
  );
  assert.equal(hydrated, true, "search never loaded the message");
}

async function threadLastOnHostileFrom(): Promise<void> {
  let fetched = false;
  await withGmail(
    (url) => {
      assert.ok(
        url.includes("/users/me/threads/thread-1?format=metadata"),
      );
      fetched = true;
      return {
        messages: [
          {
            id: "msg-last",
            internalDate: "1600000000000",
            labelIds: ["INBOX"],
            payload: {
              headers: [{ name: "From", value: hostileAddress() }],
            },
          },
        ],
      };
    },
    async () => {
      await expectBounded("getGmailThreadLast hostile From", async () => {
        const last = await getGmailThreadLast(TOKEN, "thread-1");
        assert.equal(last?.id, "msg-last");
      });
    },
  );
  assert.equal(fetched, true, "thread last never fetched the thread");
}

async function threadMessagesOnHostileFrom(): Promise<void> {
  let fetchedFull = false;
  await withGmail(
    (url) => {
      if (url.includes("/users/me/threads/thread-1?format=minimal")) {
        return { messages: [{ id: "msg-thread" }] };
      }
      assert.ok(url.includes("/users/me/messages/msg-thread?format=full"));
      fetchedFull = true;
      return fullMessage("msg-thread", hostileAddress());
    },
    async () => {
      await expectBounded("getGmailThreadMessages hostile From", async () => {
        const messages = await getGmailThreadMessages(TOKEN, "thread-1");
        assert.equal(messages.length, 1);
        assert.equal(messages[0]?.id, "msg-thread");
      });
    },
  );
  assert.equal(fetchedFull, true, "thread messages never loaded the full message");
}

await benignAddressesParse();
await currentAdapterStaysFast();
await draftLoaderOnHostileFrom();
await draftLoaderOnFoldedFrom();
await listHydratesHostileFrom();
await inboxListHydratesHostileTo();
await searchHydratesHostileCc();
await threadLastOnHostileFrom();
await threadMessagesOnHostileFrom();

assert.deepEqual(failures, [], failures.join("\n"));
