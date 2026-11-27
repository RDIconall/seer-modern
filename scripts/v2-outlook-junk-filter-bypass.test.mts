/**
 * Junk-filter bypass: an inbox sync must not treat a Junk Email (or Drafts,
 * Deleted Items, Outbox, Conversation History) message as part of the inbox
 * thread, and archive/restore/trash/move must not take that message out of
 * the folder Exchange put it in.
 *
 * The stand-in speaks the Graph shapes this adapter already requests
 * (GET /me/mailFolders/{id}/messages, GET /me/messages?$filter=conversationId,
 * GET /me/mailFolders/{well-known-name}, POST /me/messages/{id}/move).
 * parentFolderId values are opaque folder ids, matching the message resource.
 * The first resolution of a well-known folder inside one operation is the id
 * stamped on messages; a later resolution of the same folder returns a
 * different id. A filter that looks the folder up again and trusts the second
 * id will keep or move the filtered message, and these tests fail.
 *
 * Search is not covered: OutlookProvider.search renders the $search page and
 * does not expand a conversation across folders.
 */
import assert from "node:assert/strict";
import { startTestDb } from "./v2-testdb.mts";
import { upsertAccount, upsertUser } from "../src/lib/v2/db/accounts.ts";
import { OutlookProvider } from "../src/lib/v2/providers/outlook.ts";
import { syncFolder } from "../src/lib/v2/sync/engine.ts";
import { getCorpusConversation } from "../src/lib/v3/reader/repository.ts";
import { shapeThread } from "../src/lib/v3/reader/thread-shape.ts";
import { getMailboxView } from "../src/lib/v3/mailbox/repository.ts";
import { loadConversation } from "../src/lib/v2/intelligence/load-conversation.ts";
import { conversationPayload } from "../src/lib/v2/intelligence/model.ts";

const PHISH = "Verify your mailbox now";
const INBOX_BODY = "Here is the quarterly update.";
const SENT_BODY = "Thanks, the quarterly update is filed.";
const SENT_SNIPPET = "Re: Quarterly update";
const ARCHIVE_BODY = "Filed the quarterly update.";
const TRASH_BODY = "Please disregard the earlier note.";

const SELF = "me@example.com";
const SENDER = "vendor@outside.example";

/** Opaque Graph folder ids. None contain inbox/archive/deleted/trash/junk. */
const CANONICAL = {
  inbox: "AAMkAG01primarybox=",
  junkemail: "AAMkAG02filteredbox=",
  drafts: "AAMkAG03unsentbox=",
  deleteditems: "AAMkAG04removedbox=",
  outbox: "AAMkAG05pendingbox=",
  conversationhistory: "AAMkAG06chathistbox=",
  archive: "AAMkAG07storedbox=",
  sentitems: "AAMkAG08copiesbox=",
} as const;

const STALE: Record<keyof typeof CANONICAL, string> = {
  inbox: "AAMkAG91otherbox=",
  junkemail: "AAMkAG92otherbox=",
  drafts: "AAMkAG93otherbox=",
  deleteditems: "AAMkAG94otherbox=",
  outbox: "AAMkAG95otherbox=",
  conversationhistory: "AAMkAG96otherbox=",
  archive: "AAMkAG97otherbox=",
  sentitems: "AAMkAG98otherbox=",
};

const DISPLAY: Record<keyof typeof CANONICAL, string> = {
  inbox: "Inbox",
  junkemail: "Junk Email",
  drafts: "Drafts",
  deleteditems: "Deleted Items",
  outbox: "Outbox",
  conversationhistory: "Conversation History",
  archive: "Archive",
  sentitems: "Sent Items",
};

type WellKnown = keyof typeof CANONICAL;

const EXCLUDED = [
  "msg-junk",
  "msg-draft",
  "msg-deleted",
  "msg-outbox",
  "msg-history",
  "msg-trash-junk",
] as const;

type GraphMessage = {
  id: string;
  conversationId: string;
  subject: string;
  from: { emailAddress: { address: string; name: string } };
  toRecipients: { emailAddress: { address: string; name: string } }[];
  ccRecipients: [];
  receivedDateTime: string;
  bodyPreview: string;
  body: { contentType: string; content: string };
  isRead: boolean;
  hasAttachments: boolean;
  parentFolderId: string;
};

function message(input: {
  id: string;
  conversationId: string;
  folder: WellKnown;
  when: string;
  from: string;
  subject: string;
  snippet: string;
  body: string;
}): GraphMessage {
  return {
    id: input.id,
    conversationId: input.conversationId,
    subject: input.subject,
    from: { emailAddress: { address: input.from, name: input.from } },
    toRecipients: [{ emailAddress: { address: SELF, name: SELF } }],
    ccRecipients: [],
    receivedDateTime: input.when,
    bodyPreview: input.snippet,
    body: { contentType: "html", content: `<p>${input.body}</p>` },
    isRead: false,
    hasAttachments: false,
    parentFolderId: CANONICAL[input.folder],
  };
}

const PHISH_KEPT = [
  message({
    id: "msg-inbox",
    conversationId: "phish",
    folder: "inbox",
    when: "2026-08-01T10:00:00Z",
    from: SENDER,
    subject: "Quarterly update",
    snippet: "Here is the quarterly update.",
    body: INBOX_BODY,
  }),
  message({
    id: "msg-archive",
    conversationId: "phish",
    folder: "archive",
    when: "2026-08-01T11:00:00Z",
    from: SENDER,
    subject: "Quarterly update",
    snippet: "Filed the quarterly update.",
    body: ARCHIVE_BODY,
  }),
  message({
    id: "msg-sent",
    conversationId: "phish",
    folder: "sentitems",
    when: "2026-08-01T12:00:00Z",
    from: SELF,
    subject: "Quarterly update",
    snippet: SENT_SNIPPET,
    body: SENT_BODY,
  }),
];

const PHISH_EXCLUDED = [
  message({
    id: "msg-draft",
    conversationId: "phish",
    folder: "drafts",
    when: "2026-08-01T12:30:00Z",
    from: SELF,
    subject: "Quarterly update",
    snippet: "Unsent note",
    body: "Unsent note that is still a draft.",
  }),
  message({
    id: "msg-deleted",
    conversationId: "phish",
    folder: "deleteditems",
    when: "2026-08-01T13:00:00Z",
    from: SENDER,
    subject: "Quarterly update",
    snippet: "Removed from the thread",
    body: "This copy was deleted.",
  }),
  message({
    id: "msg-outbox",
    conversationId: "phish",
    folder: "outbox",
    when: "2026-08-01T13:30:00Z",
    from: SELF,
    subject: "Quarterly update",
    snippet: "Waiting to send",
    body: "Waiting in the outbox.",
  }),
  message({
    id: "msg-history",
    conversationId: "phish",
    folder: "conversationhistory",
    when: "2026-08-01T14:00:00Z",
    from: SENDER,
    subject: "Quarterly update",
    snippet: "Chat transcript",
    body: "Conversation history transcript.",
  }),
  message({
    id: "msg-junk",
    conversationId: "phish",
    folder: "junkemail",
    when: "2026-08-02T09:00:00Z",
    from: SENDER,
    subject: "Quarterly update",
    snippet: PHISH,
    body: PHISH,
  }),
];

const TRASH_KEPT = message({
  id: "msg-trash-deleted",
  conversationId: "trashed",
  folder: "deleteditems",
  when: "2026-08-03T10:00:00Z",
  from: SENDER,
  subject: "Disregard",
  snippet: TRASH_BODY,
  body: TRASH_BODY,
});

const TRASH_JUNK = message({
  id: "msg-trash-junk",
  conversationId: "trashed",
  folder: "junkemail",
  when: "2026-08-04T10:00:00Z",
  from: SENDER,
  subject: "Disregard",
  snippet: PHISH,
  body: PHISH,
});

const ALL = [...PHISH_KEPT, ...PHISH_EXCLUDED, TRASH_KEPT, TRASH_JUNK];

/**
 * Page 1 of the mailbox-wide conversation read is every phish message except
 * the sent copy and the junk copy. Those two are only on page 2, so a filter
 * that drops the second page, or that only filters the first page, cannot
 * both keep the sent reply and drop the junk reply.
 */
const PHISH_PAGE_1 = PHISH_EXCLUDED.filter((m) => m.id !== "msg-junk").concat(
  PHISH_KEPT.filter((m) => m.id !== "msg-sent"),
);
const PHISH_PAGE_2 = [
  PHISH_KEPT.find((m) => m.id === "msg-sent")!,
  // Last in Graph's page order. reply/forward target this slot today, so the
  // junk copy has to sit here or those calls would not demonstrate the bug.
  PHISH_EXCLUDED.find((m) => m.id === "msg-junk")!,
];

type Recorded = {
  kind: "move" | "reply" | "forward" | "patch";
  messageId: string;
  destinationId?: string;
};

const lookups = new Map<string, number>();
const recorded: Recorded[] = [];

function beginOperation(): void {
  lookups.clear();
  recorded.length = 0;
}

function resolveFolder(name: WellKnown) {
  const n = (lookups.get(name) ?? 0) + 1;
  lookups.set(name, n);
  return {
    id: n === 1 ? CANONICAL[name] : STALE[name],
    displayName: DISPLAY[name],
    wellKnownName: name,
  };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function conversationIdFrom(url: string): string | null {
  const decoded = decodeURIComponent(url);
  const match = decoded.match(/conversationId eq '([^']+)'/);
  return match?.[1] ?? null;
}

function messagesFor(folder: string, conversationId: string | null): GraphMessage[] {
  return ALL.filter((m) => {
    if (conversationId && m.conversationId !== conversationId) return false;
    const wellKnown = (Object.keys(CANONICAL) as WellKnown[]).find(
      (name) => CANONICAL[name] === m.parentFolderId,
    );
    return wellKnown === folder;
  });
}

const mockFetch = (async (url: string, init?: RequestInit) => {
  const method = (init?.method ?? "GET").toUpperCase();
  const parsed = new URL(url);
  const path = parsed.pathname;

  const acted = path.match(/\/messages\/([^/]+)\/(reply|replyAll|forward|move)$/);
  if (method === "POST" && acted) {
    const messageId = decodeURIComponent(acted[1]);
    const kind = acted[2];
    if (kind === "move") {
      const body = JSON.parse(String(init?.body ?? "{}")) as { destinationId?: string };
      recorded.push({ kind: "move", messageId, destinationId: body.destinationId });
      return json({ id: messageId }, 201);
    }
    recorded.push({
      kind: kind === "forward" ? "forward" : "reply",
      messageId,
    });
    return new Response("", { status: 202 });
  }

  const patched = path.match(/\/messages\/([^/]+)$/);
  if (method === "PATCH" && patched) {
    recorded.push({
      kind: "patch",
      messageId: decodeURIComponent(patched[1]),
    });
    return new Response("", { status: 200 });
  }

  const folderRoot = path.match(/\/mailFolders\/([^/]+)$/);
  if (method === "GET" && folderRoot) {
    const name = decodeURIComponent(folderRoot[1]);
    if (parsed.searchParams.get("$select") === "totalItemCount") {
      const total = name === "inbox" || name === "deleteditems" ? 1 : 0;
      return json({ totalItemCount: total });
    }
    if (!(name in CANONICAL)) {
      throw new Error(`unexpected folder lookup: ${url}`);
    }
    return json(resolveFolder(name as WellKnown));
  }

  if (method === "GET" && /\/mailFolders$/.test(path)) {
    const names = Object.keys(CANONICAL) as WellKnown[];
    return json({ value: names.map((name) => resolveFolder(name)) });
  }

  const folderMessages = path.match(/\/mailFolders\/([^/]+)\/messages$/);
  if (method === "GET" && folderMessages) {
    const name = decodeURIComponent(folderMessages[1]);
    const conversationId = conversationIdFrom(url);
    if (conversationId) return json({ value: messagesFor(name, conversationId) });
    if (name === "inbox") {
      return json({ value: PHISH_KEPT.filter((m) => m.id === "msg-inbox") });
    }
    if (name === "deleteditems") return json({ value: [TRASH_KEPT] });
    if (name === "sentitems") {
      return json({ value: PHISH_KEPT.filter((m) => m.id === "msg-sent") });
    }
    if (name === "archive") {
      return json({ value: PHISH_KEPT.filter((m) => m.id === "msg-archive") });
    }
    return json({ value: messagesFor(name, null) });
  }

  if (method === "GET" && /\/messages$/.test(path)) {
    const conversationId = conversationIdFrom(url);
    if (!conversationId) throw new Error(`unexpected message list: ${url}`);
    if (conversationId === "phish") {
      if (url.includes("skiptoken=page2")) return json({ value: PHISH_PAGE_2 });
      return json({
        value: PHISH_PAGE_1,
        "@odata.nextLink":
          "https://graph.microsoft.com/v1.0/me/messages?$filter=conversationId%20eq%20%27phish%27&$skiptoken=page2",
      });
    }
    if (conversationId === "trashed") {
      return json({ value: [TRASH_KEPT, TRASH_JUNK] });
    }
    return json({ value: [] });
  }

  throw new Error(`unexpected request: ${method} ${url}`);
}) as unknown as typeof fetch;

function provider(): OutlookProvider {
  return new OutlookProvider({
    accessToken: "test-token",
    accountEmail: SELF,
    fetchImpl: mockFetch,
    pageSize: 50,
  });
}

function idsOf(messages: { providerMessageId: string }[]): string[] {
  return messages.map((m) => m.providerMessageId);
}

function movedIds(): string[] {
  return recorded.filter((event) => event.kind === "move").map((event) => event.messageId);
}

function assertNotFiltered(ids: string[], where: string): void {
  for (const id of EXCLUDED) {
    assert.ok(!ids.includes(id), `${where} must not include ${id}`);
  }
  assert.ok(
    !ids.some((id) => id.includes("junk") || id.includes("draft") || id.includes("history")),
    `${where} leaked a filtered message id: ${ids.join(",")}`,
  );
}

const failures: string[] = [];

async function check(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
    console.log(`ok ${name}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    failures.push(`${name}: ${message}`);
    console.error(`FAIL ${name}: ${message}`);
  }
}

const db = await startTestDb();
try {
  const userId = await upsertUser("junk-bypass@example.com");
  const accountId = await upsertAccount({
    userId,
    provider: "microsoft",
    email: SELF,
  });
  const outlook = provider();

  await check("inbox sync hides filtered folders but keeps the sent reply", async () => {
    beginOperation();
    await syncFolder(accountId, outlook, "inbox", "incremental", { maxPages: 1 });
    const stored = await db.pool.query<{
      provider_message_id: string;
      snippet: string;
      body_text: string | null;
    }>(
      `select m.provider_message_id, m.snippet, m.body_text
         from seer.messages m
         join seer.conversations c on c.id = m.conversation_id
        where c.account_id = $1 and c.provider_conversation_id = 'phish'`,
      [accountId],
    );
    const ids = stored.rows.map((row) => row.provider_message_id);
    assert.ok(ids.includes("msg-inbox"), `stored ids: ${ids.join(",")}`);
    assert.ok(ids.includes("msg-sent"), `sent reply must be stored, got ${ids.join(",")}`);
    assert.ok(ids.includes("msg-archive"), `archive copy must be stored, got ${ids.join(",")}`);
    assertNotFiltered(ids, "inbox corpus");
    assert.ok(
      !stored.rows.some((row) => `${row.snippet} ${row.body_text ?? ""}`.includes(PHISH)),
      "junk body was stored on the inbox conversation",
    );
    const stamp = await db.pool.query<{ last_message_at: Date }>(
      `select last_message_at from seer.conversations
        where account_id = $1 and provider_conversation_id = 'phish'`,
      [accountId],
    );
    assert.equal(
      new Date(stamp.rows[0].last_message_at).toISOString(),
      "2026-08-01T12:00:00.000Z",
    );
  });

  await check("trash sync keeps deleted items and still drops junk", async () => {
    beginOperation();
    await syncFolder(accountId, outlook, "trash", "incremental", { maxPages: 1 });
    const stored = await db.pool.query<{ provider_message_id: string; body_text: string | null }>(
      `select m.provider_message_id, m.body_text
         from seer.messages m
         join seer.conversations c on c.id = m.conversation_id
        where c.account_id = $1 and c.provider_conversation_id = 'trashed'`,
      [accountId],
    );
    const ids = stored.rows.map((row) => row.provider_message_id);
    assert.deepEqual(ids, ["msg-trash-deleted"]);
    assert.ok(!stored.rows.some((row) => (row.body_text ?? "").includes(PHISH)));
  });

  await check("reader and chief of staff see the sent reply, not the junk body", async () => {
    const idRow = await db.pool.query<{ id: string }>(
      `select id from seer.conversations
        where account_id = $1 and provider_conversation_id = 'phish'`,
      [accountId],
    );
    const conversationId = idRow.rows[0].id;
    const view = await getCorpusConversation(accountId, conversationId, "microsoft");
    assert.ok(view);
    assertNotFiltered(idsOf(view.conversation.messages), "reader");
    assert.equal(
      view.conversation.messages[view.conversation.messages.length - 1]?.providerMessageId,
      "msg-sent",
    );
    assert.ok(
      !JSON.stringify(view.conversation).includes(PHISH),
      "reader rendered the junk body",
    );
    const lanes = shapeThread(view.conversation, "example.com", SELF);
    const laneIds = lanes.flatMap((lane) =>
      lane.kind === "turn" ? [lane.message.providerMessageId] : lane.turns.map((turn) => turn.message.providerMessageId),
    );
    assertNotFiltered(laneIds, "reader lanes");
    assert.equal(laneIds[laneIds.length - 1], "msg-sent");

    const loaded = await loadConversation(conversationId);
    assert.ok(loaded);
    const payload = conversationPayload(loaded);
    assert.ok(
      payload.messages.some((m) => m.body.includes(SENT_BODY)),
      "chief of staff payload dropped the real reply",
    );
    assert.ok(
      !JSON.stringify(payload).includes(PHISH),
      "chief of staff payload included the junk body",
    );

    const mailbox = await getMailboxView(accountId, "inbox", 50);
    const row = mailbox.rows.find((item) => item.providerConversationId === "phish");
    assert.ok(row, "inbox list omitted the thread");
    assert.equal(row.snippet, SENT_SNIPPET);
    assert.equal(row.latestMessageId, "msg-sent");
    assert.ok(!row.snippet.includes(PHISH));
  });

  await check("getConversation drops filtered folders and keeps the sent reply", async () => {
    beginOperation();
    const convo = await outlook.getConversation("phish");
    const ids = idsOf(convo.messages);
    assert.ok(ids.includes("msg-inbox"));
    assert.ok(ids.includes("msg-sent"));
    assert.ok(ids.includes("msg-archive"));
    assertNotFiltered(ids, "getConversation");
    assert.equal(convo.messages[convo.messages.length - 1]?.providerMessageId, "msg-sent");
    assert.equal(convo.lastMessageAt, "2026-08-01T12:00:00Z");
    assert.ok(!JSON.stringify(convo).includes(PHISH));
  });

  await check("archive moves the inbox copy and not junk or an already archived copy", async () => {
    beginOperation();
    const receipt = await outlook.mutateConversation("phish", "archive", "archive-key");
    const moved = movedIds();
    assert.ok(moved.includes("msg-inbox"), `archive did not move the inbox copy: ${moved.join(",")}`);
    assert.equal(
      recorded.find((event) => event.messageId === "msg-inbox")?.destinationId,
      "archive",
    );
    assert.ok(!moved.includes("msg-archive"), `archive moved the opaque archive copy: ${moved.join(",")}`);
    assertNotFiltered(moved, "archive");
    assert.ok(!receipt.failed.includes("msg-inbox"));
    assert.ok(!receipt.failed.some((id) => (EXCLUDED as readonly string[]).includes(id)));
  });

  await check("restore moves the archived copy to inbox and leaves junk where it is", async () => {
    beginOperation();
    const receipt = await outlook.mutateConversation("phish", "restore", "restore-key");
    const moved = movedIds();
    assert.ok(moved.includes("msg-archive"), `restore did not move the archived copy: ${moved.join(",")}`);
    assert.equal(
      recorded.find((event) => event.messageId === "msg-archive")?.destinationId,
      "inbox",
    );
    assert.ok(
      !moved.includes("msg-inbox"),
      `restore moved the copy already in the opaque inbox folder: ${moved.join(",")}`,
    );
    assertNotFiltered(moved, "restore");
    assert.ok(!receipt.failed.includes("msg-archive"));
  });

  await check("trash moves the inbox copy and not junk or an already deleted copy", async () => {
    beginOperation();
    const receipt = await outlook.mutateConversation("phish", "trash", "trash-key");
    const moved = movedIds();
    assert.ok(moved.includes("msg-inbox"), `trash did not move the inbox copy: ${moved.join(",")}`);
    assert.equal(
      recorded.find((event) => event.messageId === "msg-inbox")?.destinationId,
      "deleteditems",
    );
    assert.ok(
      !moved.includes("msg-deleted"),
      `trash moved the copy already in the opaque deleted folder: ${moved.join(",")}`,
    );
    assertNotFiltered(moved, "trash");
    assert.ok(!receipt.failed.includes("msg-inbox"));
  });

  await check("moveConversation does not move filtered messages", async () => {
    beginOperation();
    const destination = "AAMkAGuserfolderbox=";
    const receipt = await outlook.moveConversation("phish", destination, "move-key");
    const moved = movedIds();
    assert.ok(moved.includes("msg-inbox"), `move left the inbox copy: ${moved.join(",")}`);
    assert.equal(
      recorded.find((event) => event.messageId === "msg-inbox")?.destinationId,
      destination,
    );
    assertNotFiltered(moved, "moveConversation");
    assert.ok(!receipt.failed.some((id) => (EXCLUDED as readonly string[]).includes(id)));
  });

  await check("markUnread does not patch filtered messages", async () => {
    beginOperation();
    await outlook.mutateConversation("phish", "markUnread", "unread-key");
    const patched = recorded.filter((event) => event.kind === "patch").map((event) => event.messageId);
    assert.ok(patched.includes("msg-inbox"), `markUnread skipped the inbox copy: ${patched.join(",")}`);
    assertNotFiltered(patched, "markUnread");
  });

  await check("reply and forward do not target the junk message", async () => {
    beginOperation();
    await outlook.reply({ conversationId: "phish", all: false, bodyHtml: "<p>ok</p>" }, "reply-key");
    await outlook.forward(
      { conversationId: "phish", to: [{ email: "colleague@example.com" }], bodyHtml: "<p>fy</p>" },
      "forward-key",
    );
    const targets = recorded
      .filter((event) => event.kind === "reply" || event.kind === "forward")
      .map((event) => event.messageId);
    assert.equal(targets.length, 2);
    assertNotFiltered(targets, "reply/forward");
    for (const id of targets) {
      assert.ok(
        id === "msg-inbox" || id === "msg-sent" || id === "msg-archive",
        `reply/forward targeted ${id}`,
      );
    }
  });
} finally {
  await db.stop();
}

if (failures.length > 0) {
  console.error(`\n${failures.length} junk-filter check(s) failed:`);
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}
