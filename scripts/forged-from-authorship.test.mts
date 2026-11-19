/**
 * Spec for inbox mail whose From header is the connected mailbox.
 *
 * These tests fail while that header is treated as proof the user wrote the
 * message. They pass once outgoing is taken only from a Gmail SENT label or
 * the Outlook Sent Items folder, the reading pane does not call the message
 * the user's, reply does not address the mailbox, and the chief-of-staff
 * greeting and direct-address checks still see the inbound message.
 *
 * The fetch stand-in returns the JSON the adapters already parse. Every step
 * after that response — header parsing, sync, storage, reload, the reader,
 * and reply — is the product code.
 */
import assert from "node:assert/strict";
import { executeCommand } from "../src/lib/v2/commands/execute.ts";
import { upsertAccount, upsertUser } from "../src/lib/v2/db/accounts.ts";
import { asConversationId } from "../src/lib/v2/db/types.ts";
import { readConversation } from "../src/lib/v2/intelligence/reader.ts";
import { loadConversation } from "../src/lib/v2/intelligence/load-conversation.ts";
import { GmailProvider } from "../src/lib/v2/providers/gmail.ts";
import { OutlookProvider } from "../src/lib/v2/providers/outlook.ts";
import type { Conversation, Message } from "../src/lib/v2/providers/types.ts";
import { syncFolder } from "../src/lib/v2/sync/engine.ts";
import { getMailboxView } from "../src/lib/v3/mailbox/repository.ts";
import { getCorpusConversation } from "../src/lib/v3/reader/repository.ts";
import { shapeThread, summariseThread } from "../src/lib/v3/reader/thread-shape.ts";
import { buildInboxView } from "../src/lib/v2/view/build.ts";
import { startTestDb, type TestDb } from "./v2-testdb.mts";

const MAILBOX = "conall@rditrials.com";
const FORGED_FROM = "Outside Person <Conall@RDITrials.com>";
const GREETING = "Hi Conall, this is Rachel's Dad. Please call me today.";
const FORGED_SUBJECT = "Please call me";
const SENT_SUBJECT = "My sent note";
const MIXED_SUBJECT = "Project update";

const failures: string[] = [];

function check(name: string, fn: () => void): void {
  try {
    fn();
  } catch (error) {
    failures.push(`${name}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function b64url(value: string): string {
  return Buffer.from(value, "utf8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function gmailMessage(input: {
  id: string;
  threadId: string;
  from: string;
  to: string;
  cc?: string;
  subject: string;
  body: string;
  epoch: number;
  labels: string[];
}) {
  return {
    id: input.id,
    threadId: input.threadId,
    snippet: input.body.slice(0, 40),
    labelIds: input.labels,
    internalDate: String(input.epoch),
    payload: {
      mimeType: "text/plain",
      headers: [
        { name: "From", value: input.from },
        { name: "To", value: input.to },
        { name: "Cc", value: input.cc ?? "" },
        { name: "Subject", value: input.subject },
      ],
      body: { size: input.body.length, data: b64url(input.body) },
    },
  };
}

const forgedEpoch = Date.parse("2026-11-18T15:00:00.000Z");
const olderEpoch = Date.parse("2026-11-17T15:00:00.000Z");
const sentEpoch = Date.parse("2026-11-16T12:00:00.000Z");
const mixedInboxEpoch = Date.parse("2026-11-18T14:00:00.000Z");
const mixedSentEpoch = Date.parse("2026-11-18T16:00:00.000Z");

const GMAIL_THREADS: Record<string, { id: string; messages: ReturnType<typeof gmailMessage>[] }> = {
  forged: {
    id: "forged",
    messages: [
      gmailMessage({
        id: "forged-old",
        threadId: "forged",
        from: "Vendor <vendor@lumos.com>",
        to: "Vendors <vendors@lumos.com>",
        subject: FORGED_SUBJECT,
        body: "Weekly vendor digest. No action for any one person.",
        epoch: olderEpoch,
        labels: ["INBOX"],
      }),
      gmailMessage({
        id: "forged-new",
        threadId: "forged",
        from: FORGED_FROM,
        to: "Priya Vance <priya@lumos.com>",
        cc: "Conall Arora <conall@rditrials.com>",
        subject: FORGED_SUBJECT,
        body: GREETING,
        epoch: forgedEpoch,
        labels: ["INBOX", "UNREAD"],
      }),
    ],
  },
  mixed: {
    id: "mixed",
    messages: [
      gmailMessage({
        id: "mixed-in",
        threadId: "mixed",
        from: "Priya Vance <priya@lumos.com>",
        to: "Conall Arora <conall@rditrials.com>",
        subject: MIXED_SUBJECT,
        body: "The update is attached.",
        epoch: mixedInboxEpoch,
        labels: ["INBOX", "UNREAD"],
      }),
      gmailMessage({
        id: "mixed-sent",
        threadId: "mixed",
        from: "Conall Arora <conall@rditrials.com>",
        to: "Priya Vance <priya@lumos.com>",
        subject: MIXED_SUBJECT,
        body: "Thanks, I sent this reply.",
        epoch: mixedSentEpoch,
        labels: ["SENT"],
      }),
    ],
  },
  "sent-real": {
    id: "sent-real",
    messages: [
      gmailMessage({
        id: "sent-real-1",
        threadId: "sent-real",
        from: "Conall Arora <conall@rditrials.com>",
        to: "Priya Vance <priya@lumos.com>",
        subject: SENT_SUBJECT,
        body: "Hi Conall, I wrote this myself.",
        epoch: sentEpoch,
        labels: ["SENT"],
      }),
    ],
  },
};

let gmailReplyRaw = "";

const gmailFetch = (async (url: string, init?: RequestInit) => {
  const method = init?.method ?? "GET";
  const parsed = new URL(String(url));
  if (method === "GET" && parsed.pathname.endsWith("/threads")) {
    const query = parsed.searchParams.get("q") ?? "";
    if (query.includes("in:sent")) {
      return json({ threads: [{ id: "sent-real" }], resultSizeEstimate: 1 });
    }
    if (query.includes("in:inbox")) {
      return json({
        threads: [{ id: "forged" }, { id: "mixed" }],
        resultSizeEstimate: 2,
      });
    }
    return json({ threads: [], resultSizeEstimate: 0 });
  }
  const thread = parsed.pathname.match(/\/threads\/([^/]+)$/);
  if (method === "GET" && thread) {
    const id = decodeURIComponent(thread[1]);
    const found = GMAIL_THREADS[id];
    if (!found) throw new Error(`gmail thread miss pathname=${parsed.pathname} id=${id}`);
    return json(found);
  }
  if (method === "POST" && parsed.pathname.endsWith("/messages/send")) {
    const body = JSON.parse(String(init?.body ?? "{}")) as { raw?: string };
    gmailReplyRaw = Buffer.from(
      String(body.raw ?? "").replace(/-/g, "+").replace(/_/g, "/"),
      "base64",
    ).toString("utf8");
    return json({ id: "reply-1", threadId: "forged" });
  }
  throw new Error(`unexpected gmail request ${method} ${url}`);
}) as typeof fetch;

function graphMessage(input: {
  id: string;
  conversationId: string;
  from: string;
  fromName: string;
  to: string;
  toName: string;
  cc?: string;
  ccName?: string;
  subject: string;
  body: string;
  when: string;
  parentFolderId: string;
  isRead: boolean;
}) {
  return {
    id: input.id,
    conversationId: input.conversationId,
    subject: input.subject,
    from: { emailAddress: { address: input.from, name: input.fromName } },
    toRecipients: [{ emailAddress: { address: input.to, name: input.toName } }],
    ccRecipients: input.cc
      ? [{ emailAddress: { address: input.cc, name: input.ccName ?? "" } }]
      : [],
    receivedDateTime: input.when,
    bodyPreview: input.body.slice(0, 40),
    body: { contentType: "text", content: input.body },
    isRead: input.isRead,
    hasAttachments: false,
    parentFolderId: input.parentFolderId,
  };
}

const OUTLOOK_SENT_FOLDER = "sent-folder";
const OUTLOOK_INBOX_FOLDER = "inbox-folder";

const OUTLOOK_CONVERSATIONS: Record<string, ReturnType<typeof graphMessage>[]> = {
  forged: [
    graphMessage({
      id: "ol-old",
      conversationId: "forged",
      from: "vendor@lumos.com",
      fromName: "Vendor",
      to: "vendors@lumos.com",
      toName: "Vendors",
      subject: FORGED_SUBJECT,
      body: "Weekly vendor digest. No action for any one person.",
      when: "2026-11-17T15:00:00.000Z",
      parentFolderId: OUTLOOK_INBOX_FOLDER,
      isRead: true,
    }),
    graphMessage({
      id: "ol-sent",
      conversationId: "forged",
      from: "Conall@RDITrials.com",
      fromName: "Conall Arora",
      to: "priya@lumos.com",
      toName: "Priya Vance",
      subject: FORGED_SUBJECT,
      body: "Thanks, I sent this reply.",
      when: "2026-11-18T13:00:00.000Z",
      parentFolderId: OUTLOOK_SENT_FOLDER,
      isRead: true,
    }),
    graphMessage({
      id: "ol-new",
      conversationId: "forged",
      from: "Conall@RDITrials.com",
      fromName: "Outside Person",
      to: "priya@lumos.com",
      toName: "Priya Vance",
      cc: "conall@rditrials.com",
      ccName: "Conall Arora",
      subject: FORGED_SUBJECT,
      body: GREETING,
      when: "2026-11-18T15:00:00.000Z",
      parentFolderId: OUTLOOK_INBOX_FOLDER,
      isRead: false,
    }),
  ],
  "sent-real": [
    graphMessage({
      id: "ol-sent-only",
      conversationId: "sent-real",
      from: "conall@rditrials.com",
      fromName: "Conall Arora",
      to: "priya@lumos.com",
      toName: "Priya Vance",
      subject: SENT_SUBJECT,
      body: "Hi Conall, I wrote this myself.",
      when: "2026-11-16T12:00:00.000Z",
      parentFolderId: OUTLOOK_SENT_FOLDER,
      isRead: true,
    }),
  ],
};

const outlookFetch = (async (url: string, init?: RequestInit) => {
  const method = init?.method ?? "GET";
  const text = String(url);
  if (method === "GET" && text.includes("/mailFolders/sentitems") && !text.includes("/messages")) {
    return json({ id: OUTLOOK_SENT_FOLDER, totalItemCount: 1 });
  }
  if (method === "GET" && text.includes("/mailFolders/inbox") && !text.includes("/messages")) {
    return json({ id: OUTLOOK_INBOX_FOLDER, totalItemCount: 1 });
  }
  if (method === "GET" && text.includes("/mailFolders/inbox/messages")) {
    return json({
      value: [{ id: "ol-new", conversationId: "forged" }],
      "@odata.count": 1,
    });
  }
  if (method === "GET" && text.includes("/mailFolders/sentitems/messages")) {
    return json({
      value: [{ id: "ol-sent-only", conversationId: "sent-real" }],
      "@odata.count": 1,
    });
  }
  if (method === "GET" && text.includes("/messages?") && text.includes("conversationId")) {
    const id = text.includes("sent-real") ? "sent-real" : "forged";
    return json({ value: OUTLOOK_CONVERSATIONS[id] });
  }
  throw new Error(`unexpected outlook request ${method} ${text}`);
}) as typeof fetch;

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function byId(conversation: Conversation, id: string): Message {
  const message = conversation.messages.find((item) => item.providerMessageId === id);
  assert.ok(message, `missing message ${id}`);
  return message;
}

function assertForgedIsInbound(message: Message, where: string): void {
  check(`${where} keeps the forged From address`, () => {
    assert.equal(message.from.email, MAILBOX);
    assert.equal(message.from.name, "Outside Person");
    assert.equal(message.isUnread, true);
  });
  check(`${where} does not treat a matching From on inbox mail as outgoing`, () => {
    assert.equal(message.isOutgoing, false);
  });
}

function assertReadingPane(conversation: Conversation, where: string): void {
  const lanes = shapeThread(conversation, "rditrials.com", MAILBOX);
  const latest = lanes[lanes.length - 1];
  check(`${where} reading pane does not label the forged message You`, () => {
    assert.equal(latest?.kind, "turn");
    if (latest?.kind !== "turn") return;
    assert.equal(latest.isYou, false);
    assert.equal(latest.who, "Outside Person");
    assert.equal(latest.message.bodyText, GREETING);
  });
  check(`${where} still shows the forged sender as waiting on a reply`, () => {
    const summary = summariseThread(conversation, "rditrials.com", MAILBOX, forgedEpoch + 86_400_000);
    assert.equal(summary.waitingOn, "Outside Person");
  });
}

function assertSentStaysOutgoing(message: Message, where: string): void {
  check(`${where} still treats Sent mail from the mailbox as outgoing`, () => {
    assert.equal(message.from.email, MAILBOX);
    assert.equal(message.isOutgoing, true);
  });
  check(`${where} reading pane still labels real sent mail You`, () => {
    const lanes = shapeThread(
      {
        providerConversationId: "sent",
        subject: SENT_SUBJECT,
        messages: [message],
        lastMessageAt: message.sentAt,
      },
      "rditrials.com",
      MAILBOX,
    );
    const turn = lanes[0];
    assert.equal(turn?.kind, "turn");
    if (turn?.kind !== "turn") return;
    assert.equal(turn.isYou, true);
    assert.equal(turn.who, "You");
  });
}

const gmail = new GmailProvider({
  accessToken: "test-token",
  accountEmail: MAILBOX,
  fetchImpl: gmailFetch,
  pageSize: 10,
});

const inbox = await gmail.syncFolder("inbox");
const forged = inbox.conversations.find((item) => item.providerConversationId === "forged");
const mixed = inbox.conversations.find((item) => item.providerConversationId === "mixed");
assert.ok(forged, "inbox sync returned the forged thread");
assert.ok(mixed, "inbox sync returned the mixed thread");
assertForgedIsInbound(byId(forged, "forged-new"), "gmail inbox sync");
assertSentStaysOutgoing(byId(mixed, "mixed-sent"), "gmail inbox thread that also contains sent mail");
check("gmail inbox thread keeps the other party's message incoming", () => {
  assert.equal(byId(mixed, "mixed-in").isOutgoing, false);
});

const sentPage = await gmail.syncFolder("sent");
const sent = sentPage.conversations.find((item) => item.providerConversationId === "sent-real");
assert.ok(sent, "sent sync returned the sent thread");
assertSentStaysOutgoing(byId(sent, "sent-real-1"), "gmail sent folder");

const outlook = new OutlookProvider({
  accessToken: "test-token",
  accountEmail: MAILBOX,
  fetchImpl: outlookFetch,
  pageSize: 10,
});
const outlookInbox = await outlook.syncFolder("inbox");
const outlookForged = outlookInbox.conversations.find(
  (item) => item.providerConversationId === "forged",
);
assert.ok(outlookForged, "outlook inbox sync returned the forged conversation");
assertForgedIsInbound(byId(outlookForged, "ol-new"), "outlook inbox sync");
assertSentStaysOutgoing(
  byId(outlookForged, "ol-sent"),
  "outlook conversation hydrated during inbox sync",
);
const outlookSent = await outlook.syncFolder("sent");
const outlookSentThread = outlookSent.conversations.find(
  (item) => item.providerConversationId === "sent-real",
);
assert.ok(outlookSentThread, "outlook sent sync returned the sent conversation");
assertSentStaysOutgoing(byId(outlookSentThread, "ol-sent-only"), "outlook sent folder");

const db: TestDb = await startTestDb();
try {
  const userId = await upsertUser("owner@example.com");
  const gmailAccount = await upsertAccount({
    userId,
    provider: "google",
    email: MAILBOX,
  });
  await syncFolder(gmailAccount, gmail, "inbox", "full");
  await syncFolder(gmailAccount, gmail, "sent", "full");

  const stored = await db.pool.query<{
    id: string;
    provider_conversation_id: string;
    provider_message_id: string;
    is_outgoing: boolean;
    is_unread: boolean;
    folders: string[];
  }>(
    `select c.id, c.provider_conversation_id, c.folders,
            m.provider_message_id, m.is_outgoing, m.is_unread
       from seer.messages m
       join seer.conversations c on c.id = m.conversation_id
      where m.account_id = $1
      order by m.provider_message_id`,
    [gmailAccount],
  );
  const forgedRow = stored.rows.find((row) => row.provider_message_id === "forged-new");
  check("sync stores the forged inbox message as incoming in the inbox", () => {
    assert.ok(forgedRow, "forged message row");
    assert.equal(forgedRow?.is_outgoing, false);
    assert.equal(forgedRow?.is_unread, true);
    assert.ok(forgedRow?.folders.includes("inbox"));
  });
  const sentRow = stored.rows.find((row) => row.provider_message_id === "sent-real-1");
  check("sync stores Sent mail as outgoing in the sent folder", () => {
    assert.equal(sentRow?.is_outgoing, true);
    assert.ok(sentRow?.folders.includes("sent"));
  });

  const conversationId = asConversationId(forgedRow?.id ?? "");
  const loaded = await loadConversation(conversationId);
  assert.ok(loaded, "chief-of-staff reload");
  assertForgedIsInbound(byId(loaded, "forged-new"), "loadConversation");

  const corpus = await getCorpusConversation(gmailAccount, conversationId, "google");
  assert.ok(corpus, "reading-pane reload");
  assertReadingPane(corpus.conversation, "corpus");

  let routedDirectly = false;
  const decision = await readConversation({
    accountId: gmailAccount,
    conversationId,
    conversation: loaded,
    context: {
      ownDomain: "rditrials.com",
      ownEmail: MAILBOX,
      people: [],
      matters: [],
      interests: [],
    },
    model: async (input) => {
      routedDirectly = input.routingFacts.addressedDirectly;
      return {
        home: "delete",
        summary: "A letter asking for a call.",
        rationale: "The model saw no obligation.",
        owner: "nobody",
        ask: "nothing — informational",
        obligation: false,
        yields: [],
        evidence: [],
      };
    },
  });
  check("reader tells the model the latest inbound mail names the user", () => {
    assert.equal(routedDirectly, true);
  });
  check("personal greeting on the forged message holds delete", () => {
    assert.equal(decision.home, "record");
    assert.ok(
      decision.vetoReasons.includes("personal_greeting"),
      `${decision.home}: ${decision.vetoReasons.join(",")}`,
    );
  });
  const priority = await db.pool.query<{ priority: number }>(
    `select priority from seer.conversation_decisions
      where conversation_id = $1 and is_current`,
    [conversationId],
  );
  check("direct address on the forged message raises salience", () => {
    assert.ok((priority.rows[0]?.priority ?? 0) >= 1, String(priority.rows[0]?.priority));
  });

  const mailbox = await getMailboxView(gmailAccount, "inbox", 20);
  const listRow = mailbox.rows.find((row) => row.providerConversationId === "forged");
  check("inbox list does not present the forged message as mail the user sent", () => {
    assert.equal(listRow?.senderDisplayName, "Outside Person");
  });
  const sentList = await getMailboxView(gmailAccount, "sent", 20);
  const sentListRow = sentList.rows.find((row) => row.providerConversationId === "sent-real");
  check("sent list still presents real sent mail as mail the user sent", () => {
    assert.equal(sentListRow?.senderDisplayName, "To Priya");
  });

  const atlas = await buildInboxView(gmailAccount, "google");
  const atlasRows = [
    ...atlas.records,
    ...atlas.undecided,
    ...atlas.safeToDelete,
    ...atlas.atlas.flatMap((matter) => matter.conversations),
  ];
  const atlasRow = atlasRows.find((row) => row.providerConversationId === "forged");
  check("Atlas does not treat the forged message as the user having spoken last", () => {
    assert.ok(atlasRow, "forged conversation missing from the inbox view");
    assert.equal(atlasRow?.weSpokeLast, false);
  });

  const reply = await executeCommand(
    { accountId: gmailAccount, provider: gmail },
    {
      type: "reply",
      providerConversationId: "forged",
      all: false,
      bodyHtml: "<p>Calling now.</p>",
    },
    "reply-forged-1",
  );
  check("reply command addresses someone other than the mailbox", () => {
    assert.equal(reply.ok, true, reply.ok ? "" : reply.error);
    const toLine = gmailReplyRaw
      .split("\r\n")
      .find((line) => line.toLowerCase().startsWith("to:"));
    assert.ok(toLine, gmailReplyRaw);
    assert.equal(toLine?.toLowerCase().includes(MAILBOX), false, toLine);
  });

  const outlookAccount = await upsertAccount({
    userId,
    provider: "microsoft",
    email: MAILBOX,
  });
  await syncFolder(outlookAccount, outlook, "inbox", "full");
  const outlookStored = await db.pool.query<{
    provider_message_id: string;
    is_outgoing: boolean;
    folders: string[];
  }>(
    `select m.provider_message_id, m.is_outgoing, c.folders
       from seer.messages m
       join seer.conversations c on c.id = m.conversation_id
      where m.account_id = $1`,
    [outlookAccount],
  );
  check("outlook sync stores the inbox forgery as incoming and the sent copy as outgoing", () => {
    const inbound = outlookStored.rows.find((row) => row.provider_message_id === "ol-new");
    const outgoing = outlookStored.rows.find((row) => row.provider_message_id === "ol-sent");
    assert.equal(inbound?.is_outgoing, false);
    assert.ok(inbound?.folders.includes("inbox"));
    assert.equal(outgoing?.is_outgoing, true);
  });
} finally {
  await db.stop();
}

if (failures.length > 0) {
  throw new Error(`${failures.length} forged-From authorship check(s) failed:\n${failures.join("\n")}`);
}
