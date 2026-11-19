/**
 * Same-domain mail that this mailbox did not send must stay on the trunk,
 * under the real sender. It must not be labeled as a forward the user made,
 * and it must not be hidden in a closed internal branch.
 *
 * These assertions describe the reading pane after a message has been through
 * the provider adapter, folder sync, and the corpus reader. They fail while
 * any same-domain message is treated as the user's own forward.
 */
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { startTestDb, type TestDb } from "./v2-testdb.mts";
import { upsertAccount, upsertUser } from "../src/lib/v2/db/accounts.ts";
import type { AccountId } from "../src/lib/v2/db/types.ts";
import { GmailProvider } from "../src/lib/v2/providers/gmail.ts";
import { OutlookProvider } from "../src/lib/v2/providers/outlook.ts";
import type { Conversation, ProviderKind } from "../src/lib/v2/providers/types.ts";
import { syncFolder } from "../src/lib/v2/sync/engine.ts";
import { getCorpusConversation } from "../src/lib/v3/reader/repository.ts";
import {
  shapeThread,
  summariseThread,
  type Branch,
  type Turn,
} from "../src/lib/v3/reader/thread-shape.ts";
import { Reader } from "../src/components/v2/Reader.tsx";
import { isAllowedOrgEmail } from "../src/lib/auth/org.ts";

const VICTIM = "victim@rditrials.com";
const DOMAIN = "rditrials.com";
const NOW = Date.parse("2026-11-19T10:00:00.000Z");

const failures: { name: string; message: string }[] = [];

async function test(name: string, fn: () => Promise<void> | void) {
  try {
    await fn();
    console.log(`ok ${name}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    failures.push({ name, message });
    console.log(`not ok ${name}\n${message}\n`);
  }
}

function b64url(value: string): string {
  return Buffer.from(value, "utf8").toString("base64url");
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
}) {
  const headers = [
    { name: "From", value: input.from },
    { name: "To", value: input.to },
    { name: "Subject", value: input.subject },
  ];
  if (input.cc) headers.push({ name: "Cc", value: input.cc });
  return {
    id: input.id,
    threadId: input.threadId,
    snippet: input.body,
    labelIds: ["INBOX"],
    internalDate: String(input.epoch),
    payload: {
      mimeType: "text/plain",
      headers,
      body: { size: input.body.length, data: b64url(input.body) },
    },
  };
}

function graphMessage(input: {
  id: string;
  conversationId: string;
  from: { address: string; name: string };
  to: { address: string; name: string }[];
  cc?: { address: string; name: string }[];
  subject: string;
  body: string;
  received: string;
}) {
  return {
    id: input.id,
    conversationId: input.conversationId,
    subject: input.subject,
    from: { emailAddress: { address: input.from.address, name: input.from.name } },
    toRecipients: input.to.map((person) => ({
      emailAddress: { address: person.address, name: person.name },
    })),
    ccRecipients: (input.cc ?? []).map((person) => ({
      emailAddress: { address: person.address, name: person.name },
    })),
    receivedDateTime: input.received,
    bodyPreview: input.body,
    body: { contentType: "text", content: input.body },
    isRead: false,
    hasAttachments: false,
  };
}

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function expectText(html: string, needle: string) {
  assert.ok(html.includes(needle), `rendered reader is missing ${JSON.stringify(needle)}`);
}

function rejectText(html: string, needle: string) {
  assert.ok(!html.includes(needle), `rendered reader still contains ${JSON.stringify(needle)}`);
}

function renderReader(
  provider: ProviderKind,
  conversation: Conversation,
  ownEmail: string,
  focusMessageId?: string,
): string {
  const html = renderToString(
    createElement(Reader, {
      provider,
      conversation,
      focusMessageId,
      ownEmail,
      onReply() {},
      onReplyAll() {},
      onForward() {},
      onArchive() {},
      onDelete() {},
    }),
  );
  return html.replace(/<!--[\s\S]*?-->/g, "");
}

function turnFor(conversation: Conversation, ownEmail: string, messageId: string): Turn {
  const domain = ownEmail.split("@")[1] ?? "";
  const lanes = shapeThread(conversation, domain, ownEmail);
  const turn = lanes.find(
    (lane): lane is Turn =>
      lane.kind === "turn" && lane.message.providerMessageId === messageId,
  );
  assert.ok(
    turn,
    `${messageId} is a trunk turn, not an internal branch (${lanes
      .map((lane) => lane.kind)
      .join(",")})`,
  );
  return turn;
}

async function loadConversation(
  db: TestDb,
  accountId: AccountId,
  providerConversationId: string,
  provider: ProviderKind,
): Promise<Conversation> {
  const row = await db.pool.query<{ id: string }>(
    `select id from seer.conversations
      where account_id = $1 and provider_conversation_id = $2`,
    [accountId, providerConversationId],
  );
  assert.equal(row.rowCount, 1, `${providerConversationId} was stored by sync`);
  const view = await getCorpusConversation(accountId, row.rows[0].id, provider);
  assert.ok(view, `${providerConversationId} reloads from the corpus`);
  return view.conversation;
}

async function accountEmail(db: TestDb, accountId: AccountId): Promise<string> {
  const row = await db.pool.query<{ email: string }>(
    `select email from seer.mail_accounts where id = $1`,
    [accountId],
  );
  assert.equal(row.rowCount, 1);
  return row.rows[0].email;
}

const gmailThreads = {
  direct: {
    id: "direct",
    messages: [
      gmailMessage({
        id: "direct-1",
        threadId: "direct",
        from: "Sam Cole <Sam.Cole@RDITrials.com>",
        to: "Victim <victim@rditrials.com>",
        subject: "Wire",
        body: "Please approve the wire before noon.",
        epoch: Date.parse("2026-11-18T15:00:00.000Z"),
      }),
    ],
  },
  buried: {
    id: "buried",
    messages: [
      gmailMessage({
        id: "buried-1",
        threadId: "buried",
        from: "Priya Vance <priya@lumos.com>",
        to: "Victim <victim@rditrials.com>",
        subject: "Change order",
        body: "Customer question from Priya.",
        epoch: Date.parse("2026-11-17T09:00:00.000Z"),
      }),
      gmailMessage({
        id: "buried-2",
        threadId: "buried",
        from: "Sam Cole <sam.cole@rditrials.com>",
        to: "Victim <victim@rditrials.com>",
        cc: "Lara Bennett <lara@rditrials.com>",
        subject: "Change order",
        body: "Can you sign this today?",
        epoch: Date.parse("2026-11-17T12:00:00.000Z"),
      }),
      gmailMessage({
        id: "buried-3",
        threadId: "buried",
        from: "Priya Vance <priya@lumos.com>",
        to: "Victim <victim@rditrials.com>",
        subject: "Change order",
        body: "Following up from outside.",
        epoch: Date.parse("2026-11-18T09:00:00.000Z"),
      }),
    ],
  },
  "reply-on-forward": {
    id: "reply-on-forward",
    messages: [
      gmailMessage({
        id: "reply-1",
        threadId: "reply-on-forward",
        from: "Priya Vance <priya@lumos.com>",
        to: "Victim <victim@rditrials.com>",
        subject: "Pricing",
        body: "What is the revised price?",
        epoch: Date.parse("2026-11-16T09:00:00.000Z"),
      }),
      gmailMessage({
        id: "reply-2",
        threadId: "reply-on-forward",
        from: "Victim <victim@rditrials.com>",
        to: "Lara Bennett <lara@rditrials.com>",
        subject: "Pricing",
        body: "Lara, please check this price.",
        epoch: Date.parse("2026-11-16T10:00:00.000Z"),
      }),
      gmailMessage({
        id: "reply-3",
        threadId: "reply-on-forward",
        from: "Lara Bennett <lara@rditrials.com>",
        to: "Victim <victim@rditrials.com>",
        subject: "Pricing",
        body: "I need the signed copy by three.",
        epoch: Date.parse("2026-11-16T15:00:00.000Z"),
      }),
    ],
  },
  consecutive: {
    id: "consecutive",
    messages: [
      gmailMessage({
        id: "consecutive-1",
        threadId: "consecutive",
        from: "Sam Cole <sam.cole@rditrials.com>",
        to: "Victim <victim@rditrials.com>",
        subject: "Two asks",
        body: "First ask from Sam.",
        epoch: Date.parse("2026-11-18T08:00:00.000Z"),
      }),
      gmailMessage({
        id: "consecutive-2",
        threadId: "consecutive",
        from: "Lara Bennett <lara@rditrials.com>",
        to: "Victim <victim@rditrials.com>",
        cc: "Sam Cole <sam.cole@rditrials.com>",
        subject: "Two asks",
        body: "Second ask from Lara.",
        epoch: Date.parse("2026-11-18T09:00:00.000Z"),
      }),
    ],
  },
  "own-forward": {
    id: "own-forward",
    messages: [
      gmailMessage({
        id: "own-1",
        threadId: "own-forward",
        from: "Victim <victim@rditrials.com>",
        to: "Lara Bennett <lara@rditrials.com>",
        subject: "Budget",
        body: "Budget note for Lara only.",
        epoch: Date.parse("2026-11-18T11:00:00.000Z"),
      }),
    ],
  },
  "outside-cc": {
    id: "outside-cc",
    messages: [
      gmailMessage({
        id: "outside-1",
        threadId: "outside-cc",
        from: "Sam Cole <sam.cole@rditrials.com>",
        to: "Victim <victim@rditrials.com>",
        cc: "Priya Vance <priya@lumos.com>",
        subject: "Shared",
        body: "Sam copied the customer.",
        epoch: Date.parse("2026-11-18T13:00:00.000Z"),
      }),
    ],
  },
};

const gmailFetch = (async (url: string, init?: RequestInit) => {
  const target = String(url);
  const method = init?.method ?? "GET";
  if (method === "GET" && target.includes("/threads?")) {
    return json({
      threads: Object.values(gmailThreads).map((thread) => ({ id: thread.id })),
      resultSizeEstimate: Object.keys(gmailThreads).length,
    });
  }
  const threadGet = target.match(/\/threads\/([^?]+)\?format=full/);
  if (method === "GET" && threadGet) {
    const id = decodeURIComponent(threadGet[1]);
    const thread = gmailThreads[id as keyof typeof gmailThreads];
    assert.ok(thread, `gmail fixture has ${id}`);
    return json({ id: thread.id, messages: thread.messages });
  }
  throw new Error(`unexpected gmail request ${method} ${target}`);
}) as typeof fetch;

const outlookDirect = graphMessage({
  id: "ol-direct-1",
  conversationId: "ol-direct",
  from: { address: "sam.cole@rditrials.com", name: "Sam Cole" },
  to: [{ address: "victim@rditrials.com", name: "Victim" }],
  subject: "Hold",
  body: "Outlook please release the hold.",
  received: "2026-11-18T16:00:00.000Z",
});

const outlookCopied = [
  graphMessage({
    id: "ol-copied-1",
    conversationId: "ol-copied",
    from: { address: "sam.cole@rditrials.com", name: "Sam Cole" },
    to: [{ address: "victim@rditrials.com", name: "Victim" }],
    cc: [{ address: "lara@rditrials.com", name: "Lara Bennett" }],
    subject: "Copied inside",
    body: "Please review the internal copy.",
    received: "2026-11-18T17:00:00.000Z",
  }),
];

const outlookByConversation: Record<string, ReturnType<typeof graphMessage>[]> = {
  "ol-direct": [outlookDirect],
  "ol-copied": outlookCopied,
};

const outlookFetch = (async (url: string, init?: RequestInit) => {
  const target = String(url);
  const method = init?.method ?? "GET";
  if (method === "GET" && target.includes("/mailFolders/inbox/messages")) {
    return json({
      value: [outlookDirect, outlookCopied[0]],
      "@odata.count": 2,
    });
  }
  const conversation = decodeURIComponent(target).match(/conversationId eq '([^']+)'/);
  if (method === "GET" && target.includes("$filter") && conversation) {
    return json({ value: outlookByConversation[conversation[1]] ?? [] });
  }
  throw new Error(`unexpected outlook request ${method} ${target}`);
}) as typeof fetch;

function assertInboundOnTrunk(
  conversation: Conversation,
  ownEmail: string,
  messageId: string,
  sender: string,
  body: string,
) {
  const message = conversation.messages.find((item) => item.providerMessageId === messageId);
  assert.ok(message, `${messageId} survived sync`);
  assert.equal(message.isOutgoing, false, `${messageId} is not outgoing from this mailbox`);
  const turn = turnFor(conversation, ownEmail, messageId);
  assert.equal(turn.isYou, false);
  assert.equal(turn.who, sender);
  assert.equal(turn.body, body);
  const summary = summariseThread(conversation, ownEmail.split("@")[1] ?? "", ownEmail, NOW);
  const branch = shapeThread(conversation, ownEmail.split("@")[1] ?? "", ownEmail).find(
    (lane): lane is Branch => lane.kind === "branch",
  );
  if (branch) {
    assert.ok(
      branch.turns.every((item) => item.message.providerMessageId !== messageId),
      `${messageId} is not grouped into an internal branch`,
    );
    assert.ok(
      branch.turns.every((item) => item.isYou),
      "a branch only contains mail this mailbox sent",
    );
  }
  return { turn, summary };
}

const db = await startTestDb();
try {
  await test("any address on the organization domain may sign in", () => {
    assert.equal(isAllowedOrgEmail("sam.cole@rditrials.com"), true);
    assert.equal(isAllowedOrgEmail("Sam.Cole@RDITrials.com"), true);
    assert.equal(DOMAIN, "rditrials.com");
  });

  const userId = await upsertUser(VICTIM);
  const gmailAccount = await upsertAccount({
    userId,
    provider: "google",
    email: VICTIM,
  });
  const outlookAccount = await upsertAccount({
    userId,
    provider: "microsoft",
    email: VICTIM,
  });
  const gmailOwner = await accountEmail(db, gmailAccount);
  const outlookOwner = await accountEmail(db, outlookAccount);
  assert.equal(gmailOwner, VICTIM);
  assert.equal(outlookOwner, VICTIM);

  const gmail = new GmailProvider({
    accessToken: "placeholder",
    accountEmail: gmailOwner,
    fetchImpl: gmailFetch,
  });
  await syncFolder(gmailAccount, gmail, "inbox", "full");

  const outlook = new OutlookProvider({
    accessToken: "placeholder",
    accountEmail: outlookOwner,
    fetchImpl: outlookFetch,
  });
  await syncFolder(outlookAccount, outlook, "inbox", "full");

  const direct = await loadConversation(db, gmailAccount, "direct", "google");
  const buried = await loadConversation(db, gmailAccount, "buried", "google");
  const replyOnForward = await loadConversation(db, gmailAccount, "reply-on-forward", "google");
  const consecutive = await loadConversation(db, gmailAccount, "consecutive", "google");
  const ownForward = await loadConversation(db, gmailAccount, "own-forward", "google");
  const outsideCc = await loadConversation(db, gmailAccount, "outside-cc", "google");
  const outlookDirectConversation = await loadConversation(
    db,
    outlookAccount,
    "ol-direct",
    "microsoft",
  );
  const outlookCopiedConversation = await loadConversation(
    db,
    outlookAccount,
    "ol-copied",
    "microsoft",
  );

  await test("gmail message addressed only to the victim is not a closed forward", () => {
    const html = renderReader("google", direct, gmailOwner);
    rejectText(html, "You forwarded");
    rejectText(html, "INTERNAL");
    expectText(html, "Please approve the wire before noon.");
    expectText(html, 'aria-expanded="true"');
    expectText(html, "Sam Cole wrote");
  });

  await test("opening the same gmail message still does not call it the user's forward", () => {
    const focused = renderReader("google", direct, gmailOwner, "direct-1");
    rejectText(focused, "You forwarded");
    expectText(focused, "Please approve the wire before noon.");
    expectText(focused, "Sam Cole");
  });

  await test("gmail message addressed only to the victim stays on the trunk", () => {
    const stored = direct.messages[0];
    assert.equal(stored.from.email, "sam.cole@rditrials.com");
    assert.equal(stored.from.name, "Sam Cole");
    assert.deepEqual(stored.to.map((address) => address.email), [VICTIM]);
    assert.deepEqual(stored.cc, []);
    assert.equal(stored.isOutgoing, false);
    assert.equal(stored.bodyText, "Please approve the wire before noon.");
    const { summary } = assertInboundOnTrunk(
      direct,
      gmailOwner,
      "direct-1",
      "Sam Cole",
      "Please approve the wire before noon.",
    );
    assert.equal(summary.internal, 0);
    assert.equal(summary.waitingOn, "Sam Cole");

  });

  await test("gmail same-domain note between outside turns keeps the sender and a peek", () => {
    const stored = buried.messages.find((message) => message.providerMessageId === "buried-2");
    assert.ok(stored);
    assert.equal(stored.isOutgoing, false);
    assert.equal(stored.from.email, "sam.cole@rditrials.com");
    assert.deepEqual(
      [...stored.to, ...stored.cc].map((address) => address.email).sort(),
      ["lara@rditrials.com", VICTIM],
    );
    const turn = turnFor(buried, gmailOwner, "buried-2");
    assert.equal(turn.who, "Sam Cole");
    assert.equal(turn.isYou, false);
    assert.equal(turn.peek, "Can you sign this today?");

  });

  await test("gmail same-domain note keeps a visible peek under the real sender", () => {
    const html = renderReader("google", buried, gmailOwner);
    rejectText(html, "You forwarded");
    expectText(html, "Can you sign this today?");
    expectText(html, "Following up from outside.");
    expectText(html, "Sam Cole");
  });

  await test("a colleague reply after the user's forward is not part of that forward", () => {
    const outgoing = replyOnForward.messages.find(
      (message) => message.providerMessageId === "reply-2",
    );
    const reply = replyOnForward.messages.find(
      (message) => message.providerMessageId === "reply-3",
    );
    assert.ok(outgoing && reply);
    assert.equal(outgoing.isOutgoing, true);
    assert.equal(outgoing.from.email, VICTIM);
    assert.equal(reply.isOutgoing, false);
    assert.equal(reply.from.email, "lara@rditrials.com");
    assert.equal(reply.from.name, "Lara Bennett");

    const lanes = shapeThread(replyOnForward, DOMAIN, gmailOwner);
    const replyTurn = lanes.find(
      (lane): lane is Turn =>
        lane.kind === "turn" && lane.message.providerMessageId === "reply-3",
    );
    assert.ok(replyTurn, "the colleague reply is a trunk turn");
    assert.equal(replyTurn.who, "Lara Bennett");
    assert.equal(replyTurn.isYou, false);
    assert.equal(replyTurn.body, "I need the signed copy by three.");

    const forwarded = lanes.find((lane): lane is Branch => lane.kind === "branch");
    assert.ok(forwarded, "mail this mailbox sent can stay a branch");
    assert.ok(forwarded.turns.every((item) => item.isYou));
    assert.equal(forwarded.turns.length, 1);
    assert.match(forwarded.to, /lara/i);

    const summary = summariseThread(replyOnForward, DOMAIN, gmailOwner, NOW);
    assert.equal(summary.internal, 1);
    assert.equal(summary.waitingOn, "Lara Bennett");

  });

  await test("a colleague reply is visible and is not inside the user's forward", () => {
    const html = renderReader("google", replyOnForward, gmailOwner);
    expectText(html, "You forwarded to lara");
    expectText(html, "I need the signed copy by three.");
    expectText(html, "Lara Bennett");
    const branchHtml = html.match(/<section class="reader-branch"[\s\S]*?<\/section>/);
    assert.ok(branchHtml, "the user's own forward still renders as a branch");
    assert.ok(
      !branchHtml[0].includes("I need the signed copy by three."),
      "the colleague reply is outside the user's forward",
    );
  });

  await test("consecutive same-domain messages are separate sender turns", () => {
    for (const message of consecutive.messages) {
      assert.equal(message.isOutgoing, false);
    }
    const first = turnFor(consecutive, gmailOwner, "consecutive-1");
    const second = turnFor(consecutive, gmailOwner, "consecutive-2");
    assert.equal(first.who, "Sam Cole");
    assert.equal(first.peek, "First ask from Sam.");
    assert.equal(second.who, "Lara Bennett");
    assert.equal(second.body, "Second ask from Lara.");

  });

  await test("consecutive same-domain messages render as the senders, not one forward", () => {
    const html = renderReader("google", consecutive, gmailOwner);
    rejectText(html, "You forwarded");
    rejectText(html, "the team");
    expectText(html, "First ask from Sam.");
    expectText(html, "Second ask from Lara.");
    expectText(html, "Lara Bennett wrote");
  });

  await test("mail this mailbox sent is still the user's forward", () => {
    const message = ownForward.messages[0];
    assert.equal(message.isOutgoing, true);
    assert.equal(message.from.email, VICTIM);
    const lanes = shapeThread(ownForward, DOMAIN, gmailOwner);
    assert.equal(lanes.length, 1);
    assert.equal(lanes[0].kind, "branch");
    const branch = lanes[0] as Branch;
    assert.equal(branch.turns.length, 1);
    assert.equal(branch.turns[0].isYou, true);
    assert.equal(branch.turns[0].who, "You");
    assert.match(branch.to, /^lara$/i);
    const html = renderReader("google", ownForward, gmailOwner);
    assert.match(html, /You forwarded to lara/);
    assert.match(html, /aria-expanded="false"/);
    assert.doesNotMatch(html, /Budget note for Lara only/);
  });

  await test("a same-domain sender who copies someone outside stays on the trunk", () => {
    const message = outsideCc.messages[0];
    assert.equal(message.isOutgoing, false);
    assert.ok(message.cc.some((address) => address.email === "priya@lumos.com"));
    const turn = turnFor(outsideCc, gmailOwner, "outside-1");
    assert.equal(turn.who, "Sam Cole");
    const html = renderReader("google", outsideCc, gmailOwner);
    rejectText(html, "You forwarded");
    expectText(html, "Sam copied the customer.");
  });

  await test("outlook message addressed only to the victim stays on the trunk", () => {
    const stored = outlookDirectConversation.messages[0];
    assert.equal(stored.providerMessageId, "ol-direct-1");
    assert.equal(stored.from.email, "sam.cole@rditrials.com");
    assert.equal(stored.from.name, "Sam Cole");
    assert.deepEqual(stored.to.map((address) => address.email), [VICTIM]);
    assert.deepEqual(stored.cc, []);
    assert.equal(stored.isOutgoing, false);
    assert.equal(stored.bodyText, "Outlook please release the hold.");
    const { summary } = assertInboundOnTrunk(
      outlookDirectConversation,
      outlookOwner,
      "ol-direct-1",
      "Sam Cole",
      "Outlook please release the hold.",
    );
    assert.equal(summary.internal, 0);
    assert.equal(summary.waitingOn, "Sam Cole");
  });

  await test("outlook message addressed only to the victim is not a closed forward", () => {
    const html = renderReader("microsoft", outlookDirectConversation, outlookOwner);
    rejectText(html, "You forwarded");
    expectText(html, "Outlook please release the hold.");
    expectText(html, 'aria-expanded="true"');
    expectText(html, "Sam Cole");
  });

  await test("outlook message with to and cc on the domain stays on the trunk", () => {
    const stored = outlookCopiedConversation.messages[0];
    assert.equal(stored.isOutgoing, false);
    assert.equal(stored.from.email, "sam.cole@rditrials.com");
    assert.deepEqual(stored.to.map((address) => address.email), [VICTIM]);
    assert.deepEqual(stored.cc.map((address) => address.email), ["lara@rditrials.com"]);
    const turn = turnFor(outlookCopiedConversation, outlookOwner, "ol-copied-1");
    assert.equal(turn.who, "Sam Cole");
    assert.equal(turn.body, "Please review the internal copy.");
  });

  await test("outlook message with to and cc on the domain is not a closed forward", () => {
    const html = renderReader("microsoft", outlookCopiedConversation, outlookOwner);
    rejectText(html, "You forwarded");
    expectText(html, "Please review the internal copy.");
    expectText(html, "Sam Cole");
  });
} finally {
  await db.stop();
}

if (failures.length > 0) {
  console.error(`${failures.length} failed`);
  process.exit(1);
}

console.log("v3-internal-forward-mislabel: OK");
