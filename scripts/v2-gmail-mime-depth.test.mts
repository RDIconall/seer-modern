/**
 * A Gmail thread whose MIME parts are nested several thousand levels deep must
 * not abort a folder page. The payload shape is the users.threads.get
 * format=full resource: Message.payload is a MessagePart, and MessagePart.parts
 * is the recursive list of child multipart parts.
 *
 * These tests fail while that tree is walked without a bound. They pass once a
 * nested thread cannot throw a stack overflow and cannot drop the rest of the
 * page or pin the sync cursor.
 */
import assert from "node:assert/strict";
import { GmailProvider } from "../src/lib/v2/providers/gmail.ts";
import { getGmailMessage, getGmailThreadMessages } from "../src/lib/mail/gmail.ts";
import { upsertAccount, upsertUser } from "../src/lib/v2/db/accounts.ts";
import { syncFolder } from "../src/lib/v2/sync/engine.ts";
import { startTestDb } from "./v2-testdb.mts";

/** Deep enough to overflow the default Node stack in walkBodies, still far under Gmail's 25MB message limit. */
const NEST_DEPTH = 7000;

function b64url(value: string): string {
  return Buffer.from(value, "utf8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function nestedParts(depth: number): string {
  let part = `{"mimeType":"text/plain","body":{"size":4,"data":"${b64url("body")}"}}`;
  for (let i = 0; i < depth; i++) {
    part = `{"mimeType":"multipart/mixed","parts":[${part}]}`;
  }
  return part;
}

const NESTED_PARTS = nestedParts(NEST_DEPTH);

function messageJson(id: string, threadId: string, nested: boolean): string {
  const headers = [
    { name: "From", value: nested ? "attacker@example.com" : "friend@example.com" },
    { name: "To", value: "me@example.com" },
    { name: "Cc", value: "cc@example.com" },
    { name: "Subject", value: nested ? "Nested" : "Real mail" },
  ];
  const payload = nested
    ? `{"mimeType":"multipart/mixed","headers":${JSON.stringify(headers)},"parts":[${NESTED_PARTS}]}`
    : JSON.stringify({
        mimeType: "text/html",
        headers,
        body: { size: 9, data: b64url("<p>ok</p>") },
      });
  return JSON.stringify({
    id,
    threadId,
    snippet: nested ? "nested" : "hello",
    labelIds: ["INBOX", "UNREAD"],
    internalDate: "1600000200000",
  }).replace(/}$/, `,"payload":${payload}}`);
}

function threadJson(id: string, nested: boolean): string {
  return `{"id":${JSON.stringify(id)},"messages":[${messageJson(`${id}-m`, id, nested)}]}`;
}

function response(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: { "content-type": "application/json" },
  });
}

function createMailbox() {
  const listUrls: string[] = [];
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    const u = String(url);
    const method = (init?.method ?? "GET").toUpperCase();
    if (method === "GET" && u.includes("/threads?")) {
      listUrls.push(u);
      const query = new URL(u).searchParams;
      if (query.get("pageToken") === "page-2") {
        return response(
          JSON.stringify({ threads: [{ id: "later" }], resultSizeEstimate: 3 }),
        );
      }
      return response(
        JSON.stringify({
          threads: [{ id: "bomb" }, { id: "good" }],
          nextPageToken: "page-2",
          resultSizeEstimate: 3,
        }),
      );
    }
    const thread = u.match(/\/threads\/([^/?]+)/);
    if (method === "GET" && thread) {
      const id = decodeURIComponent(thread[1]);
      return response(threadJson(id, id === "bomb"));
    }
    const message = u.match(/\/messages\/([^/?]+)/);
    if (method === "GET" && message && !u.includes("/attachments/")) {
      const id = decodeURIComponent(message[1]);
      const threadId = id.endsWith("-m") ? id.slice(0, -2) : id;
      return response(messageJson(id, threadId, id.startsWith("bomb")));
    }
    if (method === "POST" && u.includes("/messages/send")) {
      return response(JSON.stringify({ id: "sent-1", threadId: "sent-1" }));
    }
    if (method === "POST") {
      return response(JSON.stringify({ id: "ok" }));
    }
    throw new Error(`unexpected ${method} ${u}`);
  }) as unknown as typeof fetch;

  const provider = new GmailProvider({
    accessToken: "test-token",
    accountEmail: "me@example.com",
    fetchImpl,
    pageSize: 10,
  });
  return { provider, listUrls, fetchImpl };
}

function isStackOverflow(err: unknown): boolean {
  return (
    err instanceof Error &&
    (err.name === "RangeError" || /Maximum call stack size exceeded/.test(err.message))
  );
}

/** A bounded refusal is acceptable. A stack overflow is the bug. */
async function settlesWithoutStackOverflow(run: () => Promise<unknown>): Promise<void> {
  try {
    await run();
  } catch (err) {
    if (isStackOverflow(err)) throw err;
  }
}

function assertSafePage(page: {
  conversations: {
    providerConversationId: string;
    messages: { bodyHtml: string | null }[];
  }[];
  nextCursor: string | null;
}): void {
  assert.equal(page.nextCursor, "page-2");
  const good = page.conversations.find((c) => c.providerConversationId === "good");
  assert.ok(good, "the safe thread on the same page must still be returned");
  assert.equal(good.messages[0]?.bodyHtml, "<p>ok</p>");
}

const failures: string[] = [];

async function check(name: string, run: () => Promise<void>): Promise<void> {
  try {
    await run();
    console.log(`PASS ${name}`);
  } catch (err) {
    const message = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
    failures.push(`${name}: ${message}`);
    console.log(`FAIL ${name}: ${message}`);
  }
}

await check("syncFolder keeps the safe inbox thread and the next cursor", async () => {
  const { provider } = createMailbox();
  assertSafePage(await provider.syncFolder("inbox", null));
});

await check("sync() keeps the safe inbox thread and the next cursor", async () => {
  const { provider } = createMailbox();
  assertSafePage(await provider.sync());
});

await check("syncFolder keeps the safe sent thread and the next cursor", async () => {
  const { provider } = createMailbox();
  assertSafePage(await provider.syncFolder("sent", null));
});

await check("syncFolder keeps the safe trash thread and the next cursor", async () => {
  const { provider } = createMailbox();
  assertSafePage(await provider.syncFolder("trash", null));
});

await check("search keeps the safe thread when another hit is nested too deep", async () => {
  const { provider } = createMailbox();
  const result = await provider.search("from:attacker@example.com");
  const good = result.conversations.find((c) => c.providerConversationId === "good");
  assert.ok(good, "search must still return the safe thread");
  assert.equal(good.messages[0]?.bodyHtml, "<p>ok</p>");
});

await check("getConversation does not overflow the stack", async () => {
  const { provider } = createMailbox();
  await settlesWithoutStackOverflow(() => provider.getConversation("bomb"));
});

await check("reply does not overflow the stack", async () => {
  const { provider } = createMailbox();
  await settlesWithoutStackOverflow(() =>
    provider.reply({ conversationId: "bomb", all: false, bodyHtml: "<p>reply</p>" }, "reply-key"),
  );
});

await check("forward does not overflow the stack", async () => {
  const { provider } = createMailbox();
  await settlesWithoutStackOverflow(() =>
    provider.forward(
      { conversationId: "bomb", to: [{ email: "fwd@example.com" }], bodyHtml: "<p>fwd</p>" },
      "forward-key",
    ),
  );
});

await check("getAttachment does not overflow the stack", async () => {
  const { provider } = createMailbox();
  await settlesWithoutStackOverflow(() => provider.getAttachment("bomb-m", "missing"));
});

await check("legacy getGmailMessage does not overflow the stack", async () => {
  const { fetchImpl } = createMailbox();
  const previous = globalThis.fetch;
  globalThis.fetch = fetchImpl;
  try {
    await settlesWithoutStackOverflow(() => getGmailMessage("test-token", "bomb-m"));
  } finally {
    globalThis.fetch = previous;
  }
});

await check("legacy getGmailThreadMessages does not overflow the stack", async () => {
  const { fetchImpl } = createMailbox();
  const previous = globalThis.fetch;
  globalThis.fetch = fetchImpl;
  try {
    await settlesWithoutStackOverflow(() => getGmailThreadMessages("test-token", "bomb"));
  } finally {
    globalThis.fetch = previous;
  }
});

await check("backfill stores the safe thread and advances past the nested one", async () => {
  const db = await startTestDb();
  try {
    const userId = await upsertUser("mime-depth@example.com");
    const accountId = await upsertAccount({
      userId,
      provider: "google",
      email: "mime-depth@example.com",
    });
    const { provider, listUrls } = createMailbox();
    const run = await syncFolder(accountId, provider, "inbox", "full", { maxPages: 1 });
    assert.equal(run.pages, 1);
    const stored = await db.pool.query<{ id: string; body_html: string | null }>(
      `select c.provider_conversation_id as id, m.body_html
         from seer.conversations c
         join seer.messages m on m.conversation_id = c.id
        where c.account_id = $1`,
      [accountId],
    );
    const good = stored.rows.find((row) => row.id === "good");
    assert.ok(good, "the safe thread must be committed with the page");
    assert.equal(good.body_html, "<p>ok</p>");
    const state = await db.pool.query<{ cursor: string | null }>(
      `select cursor from seer.folder_sync_state
        where account_id = $1 and folder = 'inbox'`,
      [accountId],
    );
    assert.equal(state.rows[0]?.cursor, "page-2");

    listUrls.length = 0;
    await syncFolder(accountId, provider, "inbox", "full", { maxPages: 1 });
    assert.ok(
      listUrls.some((url) => new URL(url).searchParams.get("pageToken") === "page-2"),
      "the next tick must read the following page, not the nested thread again",
    );
  } finally {
    await db.stop();
  }
});

await check("login catch-up stores the safe thread from the newest page", async () => {
  const db = await startTestDb();
  try {
    const userId = await upsertUser("mime-catchup@example.com");
    const accountId = await upsertAccount({
      userId,
      provider: "google",
      email: "mime-catchup@example.com",
    });
    const { provider } = createMailbox();
    const run = await syncFolder(accountId, provider, "inbox", "incremental", {
      maxPages: 1,
      headOnly: true,
      pageSize: 15,
    });
    assert.equal(run.pages, 1);
    assert.equal(run.polledHead, true);
    const stored = await db.pool.query<{ id: string; body_html: string | null }>(
      `select c.provider_conversation_id as id, m.body_html
         from seer.conversations c
         join seer.messages m on m.conversation_id = c.id
        where c.account_id = $1`,
      [accountId],
    );
    const good = stored.rows.find((row) => row.id === "good");
    assert.ok(good, "catch-up must commit the safe thread on the newest page");
    assert.equal(good.body_html, "<p>ok</p>");
  } finally {
    await db.stop();
  }
});

if (failures.length > 0) {
  console.error(`\n${failures.length} check(s) failed`);
  process.exit(1);
}
