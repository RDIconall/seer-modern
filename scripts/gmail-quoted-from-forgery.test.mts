/**
 * Sender identity must come from the RFC 5322 mailbox, never from an address
 * that appears only inside a quoted display name or a comment.
 *
 * These tests fail while the Gmail header parsers split address lists on every
 * comma. They pass once From, To, and Cc are parsed as address lists and the
 * stored sender is the angle-addr of that mailbox.
 *
 * Outlook is not covered. Its adapter reads Graph emailAddress.address fields.
 * The outbound Graph composer splits an address list the user typed; that is
 * not an inbound sender header.
 */
import assert from "node:assert/strict";
import { startTestDb } from "./v2-testdb.mts";
import { upsertUser, upsertAccount } from "../src/lib/v2/db/accounts.ts";
import { GmailProvider } from "../src/lib/v2/providers/gmail.ts";
import { syncAccount } from "../src/lib/v2/sync/engine.ts";
import { loadContextInput } from "../src/lib/v2/intelligence/context-loader.ts";
import { loadConversation } from "../src/lib/v2/intelligence/load-conversation.ts";
import {
  readConversation,
  type ReaderModel,
  type ReaderModelInput,
} from "../src/lib/v2/intelligence/reader.ts";
import { buildInboxView } from "../src/lib/v2/view/build.ts";
import { getMailboxView } from "../src/lib/v3/mailbox/repository.ts";
import { getCorpusConversation } from "../src/lib/v3/reader/repository.ts";
import {
  getGmailMessage,
  getGmailThreadLast,
  listGmailFolder,
} from "../src/lib/mail/gmail.ts";
import { asConversationId } from "../src/lib/v2/db/types.ts";
import type { ReadResult } from "../src/lib/v2/intelligence/schema.ts";

const OWN = "user@company.example";
const ATTACKER = "attacker@attacker.example";
const FORGED_VIP = "partner@sponsor.example";
const FORGED_INTERNAL = "alex@company.example";
const OTHER = "other@attacker.example";
const JANE = "jane@smith.example";
const BOB = "bob@other.example";
const ADA = "ada@example.com";
const SAVED_VIP_NAME = "Pat Sponsor";
const SAVED_INTERNAL_NAME = "Alex From Directory";

/** One mailbox. The address inside the quotes is not a mailbox. */
const FORGED_FROM =
  `"Newsletter <${FORGED_VIP}>, via" <${ATTACKER}> (not <${FORGED_VIP}>)`;
/** Comment before the mailbox must not win over the angle-addr. */
const COMMENT_FIRST_FROM =
  `(see <${FORGED_VIP}>) "Newsletter" <${ATTACKER}>`;
const INTERNAL_FROM =
  `"Desk Bot <${FORGED_INTERNAL}>, desk" <${ATTACKER}>`;
const SELF_FROM = `"User <${OWN}>, me" <${ATTACKER}>`;
const QUOTED_NAME_FROM = `"Smith, Jane" <${JANE}>`;
const QUOTED_NAME_TO = `"Smith, Jane" <${JANE}>, Bob Plain <${BOB}>`;
const FORGED_TO = `"Newsletter <${FORGED_VIP}>, via" <${OWN}>`;
const FORGED_CC = `"Desk Bot <${FORGED_INTERNAL}>, desk" <${OTHER}>`;
const PLAIN_FROM = `Ada Lovelace <${ADA}>`;

const BODY = "Quarterly numbers attached.";

function b64url(value: string): string {
  return Buffer.from(value, "utf8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function gmailMessage(
  id: string,
  from: string,
  to: string,
  cc = "",
) {
  return {
    id: `${id}-m1`,
    threadId: id,
    snippet: BODY,
    labelIds: ["INBOX", "UNREAD"],
    internalDate: String(Date.now()),
    payload: {
      mimeType: "text/plain",
      headers: [
        { name: "From", value: from },
        { name: "To", value: to },
        { name: "Cc", value: cc },
        { name: "Subject", value: id },
      ],
      body: { size: BODY.length, data: b64url(BODY) },
    },
  };
}

const THREADS = {
  forged: gmailMessage("forged", FORGED_FROM, FORGED_TO, FORGED_CC),
  "comment-first": gmailMessage("comment-first", COMMENT_FIRST_FROM, OWN),
  internal: gmailMessage("internal", INTERNAL_FROM, OWN),
  self: gmailMessage("self", SELF_FROM, OWN),
  quoted: gmailMessage("quoted", QUOTED_NAME_FROM, QUOTED_NAME_TO),
  plain: gmailMessage("plain", PLAIN_FROM, OWN),
};

let lastSentMime = "";

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

const v2Fetch = (async (url: string, init?: RequestInit) => {
  const target = String(url);
  const method = init?.method ?? "GET";
  if (method === "GET" && target.includes("/threads?")) {
    const query = new URL(target).searchParams.get("q") ?? "";
    const ids = query.includes("in:inbox") ? Object.keys(THREADS) : [];
    return json({
      threads: ids.map((id) => ({ id })),
      resultSizeEstimate: ids.length,
    });
  }
  const thread = target.match(/\/threads\/([^/?]+)/);
  if (method === "GET" && thread) {
    const id = decodeURIComponent(thread[1]);
    const message = THREADS[id as keyof typeof THREADS];
    if (!message) return new Response("not found", { status: 404 });
    return json({ id, messages: [message] });
  }
  if (method === "POST" && target.endsWith("/messages/send")) {
    const body = JSON.parse(String(init?.body ?? "{}")) as { raw?: string };
    const raw = body.raw ?? "";
    lastSentMime = Buffer.from(
      raw.replace(/-/g, "+").replace(/_/g, "/"),
      "base64",
    ).toString("utf8");
    return json({ id: "sent-1", threadId: "forged" });
  }
  return new Response(`unexpected ${method} ${target}`, { status: 500 });
}) as typeof fetch;

function emailsOf(header: string): string[] {
  const match = header.match(/^To:\s*(.*)$/im);
  if (!match) return [];
  return match[1]
    .split(",")
    .map((part) => part.trim().toLowerCase())
    .filter(Boolean);
}

function deleteRead(): ReadResult {
  return {
    home: "delete",
    summary: "No action.",
    rationale: "Informational.",
    owner: "nobody",
    ask: "nothing",
    obligation: false,
    yields: [],
    evidence: [],
  };
}

function matterRead(): ReadResult {
  return {
    home: "matter",
    summary: "Board pack.",
    rationale: "A request.",
    owner: "you",
    ask: "Please review the board pack",
    obligation: false,
    matterRef: "Board pack",
    yields: [],
    evidence: [],
  };
}

const failures: string[] = [];

function check(condition: unknown, message: string): void {
  if (!condition) failures.push(message);
}

function sameEmails(actual: string[] | null | undefined, expected: string[]): boolean {
  const got = (actual ?? []).map((email) => email.toLowerCase());
  return got.length === expected.length && expected.every((email, i) => got[i] === email);
}

const db = await startTestDb();
try {
  const userId = await upsertUser(OWN);
  const accountId = await upsertAccount({
    userId,
    provider: "google",
    email: OWN,
  });
  await db.pool.query(
    `insert into seer.people
       (account_id, email, display_name, tier, vip, vip_source)
     values
       ($1, $2, $3, 'known', true, 'user'),
       ($1, $4, $5, 'inner', false, 'inferred')`,
    [accountId, FORGED_VIP, SAVED_VIP_NAME, FORGED_INTERNAL, SAVED_INTERNAL_NAME],
  );

  const provider = new GmailProvider({
    accessToken: "test-token",
    accountEmail: OWN,
    fetchImpl: v2Fetch,
    pageSize: 10,
  });

  await syncAccount(accountId, provider, "full");

  const stored = await db.pool.query<{
    provider_conversation_id: string;
    from_email: string | null;
    from_name: string | null;
    to_emails: string[] | null;
    cc_emails: string[] | null;
    is_outgoing: boolean;
    conversation_id: string;
  }>(
    `select c.provider_conversation_id, c.id as conversation_id,
            m.from_email, m.from_name, m.to_emails, m.cc_emails, m.is_outgoing
       from seer.messages m
       join seer.conversations c on c.id = m.conversation_id
      where m.account_id = $1`,
    [accountId],
  );
  const byThread = new Map(stored.rows.map((row) => [row.provider_conversation_id, row]));

  const forged = byThread.get("forged");
  check(forged?.from_email === ATTACKER, `stored forged from_email was ${forged?.from_email}`);
  check(
    !forged?.from_email?.includes(FORGED_VIP),
    "stored from_email kept the address from inside the quoted display name",
  );
  check(sameEmails(forged?.to_emails, [OWN]), `stored forged to_emails was ${forged?.to_emails}`);
  check(sameEmails(forged?.cc_emails, [OTHER]), `stored forged cc_emails was ${forged?.cc_emails}`);
  check(forged?.is_outgoing === false, "forged sender was stored as outgoing");

  const commentFirst = byThread.get("comment-first");
  check(
    commentFirst?.from_email === ATTACKER,
    `comment-first from_email was ${commentFirst?.from_email}`,
  );

  const internal = byThread.get("internal");
  check(
    internal?.from_email === ATTACKER,
    `internal-looking from_email was ${internal?.from_email}`,
  );
  check(internal?.is_outgoing === false, "internal forgery was stored as outgoing");

  const self = byThread.get("self");
  check(self?.from_email === ATTACKER, `self-looking from_email was ${self?.from_email}`);
  check(self?.is_outgoing === false, "quoting the mailbox owner marked the message outgoing");

  const quoted = byThread.get("quoted");
  check(quoted?.from_email === JANE, `quoted display-name from_email was ${quoted?.from_email}`);
  check(
    sameEmails(quoted?.to_emails, [JANE, BOB]),
    `quoted display-name to_emails was ${quoted?.to_emails}`,
  );

  const plain = byThread.get("plain");
  check(plain?.from_email === ADA, `plain from_email was ${plain?.from_email}`);

  const mailbox = await getMailboxView(accountId, "inbox", 50);
  const forgedRow = mailbox.rows.find((row) => row.providerConversationId === "forged");
  const internalRow = mailbox.rows.find((row) => row.providerConversationId === "internal");
  check(Boolean(forgedRow), "mailbox list omitted the forged thread");
  check(
    forgedRow?.senderDisplayName !== SAVED_VIP_NAME,
    `mailbox showed the saved VIP name ${forgedRow?.senderDisplayName}`,
  );
  check(
    internalRow?.senderDisplayName !== SAVED_INTERNAL_NAME,
    `mailbox showed the saved internal name ${internalRow?.senderDisplayName}`,
  );

  const reader = forged
    ? await getCorpusConversation(accountId, forged.conversation_id, "google")
    : null;
  check(
    reader?.conversation.messages[0]?.from.email === ATTACKER,
    `reader from was ${reader?.conversation.messages[0]?.from.email}`,
  );
  check(
    sameEmails(
      reader?.conversation.messages[0]?.to.map((address) => address.email),
      [OWN],
    ),
    `reader to was ${reader?.conversation.messages[0]?.to.map((address) => address.email)}`,
  );
  check(
    sameEmails(
      reader?.conversation.messages[0]?.cc.map((address) => address.email),
      [OTHER],
    ),
    `reader cc was ${reader?.conversation.messages[0]?.cc.map((address) => address.email)}`,
  );

  const context = await loadContextInput(accountId, OWN);
  const forgedConversation = forged
    ? await loadConversation(forged.conversation_id)
    : null;
  const internalConversation = internal
    ? await loadConversation(internal.conversation_id)
    : null;

  let forgedModel: ReaderModelInput | null = null;
  const forgedDecision = forgedConversation
    ? await readConversation({
        accountId,
        conversationId: asConversationId(forged.conversation_id),
        conversation: forgedConversation,
        context,
        model: (async (input) => {
          forgedModel = input;
          return deleteRead();
        }) as ReaderModel,
      })
    : null;
  check(forgedModel?.routingFacts.senderIsKnown === false, "chief of staff treated the forged VIP as known");
  check(
    forgedModel?.routingFacts.senderIsInternal === false,
    "chief of staff treated the forged VIP domain as internal",
  );
  check(
    forgedModel?.contextText.includes(ATTACKER) === true &&
      forgedModel?.contextText.includes("(VIP)") !== true,
    `context text was ${forgedModel?.contextText}`,
  );
  check(forgedDecision?.home === "delete", `delete of an unknown sender became ${forgedDecision?.home}`);
  check(
    !(forgedDecision?.vetoReasons ?? []).includes("known_sender"),
    `delete vetoes were ${forgedDecision?.vetoReasons}`,
  );
  check(
    !(forgedDecision?.vetoReasons ?? []).includes("internal_sender"),
    `delete vetoes included internal_sender: ${forgedDecision?.vetoReasons}`,
  );
  const forgedPriority = forged
    ? await db.pool.query<{ priority: number }>(
        `select priority from seer.conversation_decisions
          where conversation_id = $1 and is_current`,
        [forged.conversation_id],
      )
    : null;
  check(
    forgedPriority?.rows[0]?.priority === 1,
    `salience priority was ${forgedPriority?.rows[0]?.priority}`,
  );

  let internalModel: ReaderModelInput | null = null;
  const internalDecision = internalConversation
    ? await readConversation({
        accountId,
        conversationId: asConversationId(internal.conversation_id),
        conversation: internalConversation,
        context,
        model: (async (input) => {
          internalModel = input;
          return matterRead();
        }) as ReaderModel,
      })
    : null;
  check(
    internalModel?.routingFacts.senderIsInternal === false,
    "chief of staff treated the forged colleague as internal",
  );
  check(
    internalModel?.routingFacts.senderIsKnown === false,
    "chief of staff treated the forged colleague as known",
  );
  check(
    internalModel?.contextText.includes("inside your organization") !== true,
    `internal context text was ${internalModel?.contextText}`,
  );
  check(
    internalDecision?.home === "record",
    `untrusted sender was promoted to ${internalDecision?.home}`,
  );
  check(
    (internalDecision?.vetoReasons ?? []).includes("matter_untrusted_sender"),
    `matter vetoes were ${internalDecision?.vetoReasons}`,
  );

  const atlas = await buildInboxView(accountId, "google");
  const atlasRows = [
    ...atlas.records,
    ...atlas.safeToDelete,
    ...atlas.undecided,
    ...atlas.atlas.flatMap((card) => card.conversations),
  ];
  const atlasForged = atlasRows.find((row) => row.providerConversationId === "forged");
  const atlasInternal = atlasRows.find((row) => row.providerConversationId === "internal");
  check(atlasForged?.from !== SAVED_VIP_NAME, `atlas from was ${atlasForged?.from}`);
  check(
    atlasForged?.counterparty === "Attacker",
    `atlas counterparty was ${atlasForged?.counterparty}`,
  );
  check(
    atlasInternal?.counterparty === "Attacker",
    `atlas treated the sender as internal (${atlasInternal?.counterparty})`,
  );

  await provider.reply(
    { conversationId: "forged", all: true, bodyHtml: "<p>ok</p>" },
    "reply-key",
  );
  const sentTo = emailsOf(lastSentMime);
  check(sentTo.includes(ATTACKER), `reply To was ${lastSentMime}`);
  check(!sentTo.includes(FORGED_VIP), "reply was addressed to the quoted VIP address");
  check(!sentTo.includes(FORGED_INTERNAL), "reply-all was addressed to the quoted colleague");
  check(!lastSentMime.includes(FORGED_VIP), "outbound MIME still named the quoted VIP address");

  const searched = await provider.search("in:inbox");
  const searchedForged = searched.conversations.find(
    (conversation) => conversation.providerConversationId === "forged",
  );
  check(
    searchedForged?.messages[0]?.from.email === ATTACKER,
    `search from was ${searchedForged?.messages[0]?.from.email}`,
  );

  await checkLegacyList();

  if (failures.length > 0) {
    throw new Error(`gmail address-list forgery\n${failures.join("\n")}`);
  }
  console.log("gmail-quoted-from-forgery: OK");
} finally {
  await db.stop();
}

async function checkLegacyList(): Promise<void> {
  const previous = globalThis.fetch;
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    const target = String(url);
    const method = init?.method ?? "GET";
    if (method === "GET" && target.includes("/messages?") && !target.includes("/messages/")) {
      return json({
        messages: [{ id: "legacy-1", threadId: "legacy-thread" }],
      });
    }
    if (method === "GET" && target.includes("/messages/legacy-1")) {
      return json(THREADS.forged);
    }
    if (method === "GET" && target.includes("/threads/legacy-thread")) {
      return json({
        messages: [
          {
            id: "legacy-1",
            internalDate: String(Date.now()),
            labelIds: ["INBOX"],
            payload: { headers: [{ name: "From", value: FORGED_FROM }] },
          },
        ],
      });
    }
    return new Response(`unexpected ${method} ${target}`, { status: 500 });
  }) as typeof fetch;
  try {
    const listed = await listGmailFolder("test-token", "inbox", 10);
    const item = listed[0];
    check(item?.fromEmail === ATTACKER, `legacy list fromEmail was ${item?.fromEmail}`);
    check(item?.peerEmail === OWN, `legacy list peerEmail was ${item?.peerEmail}`);
    const participants = item?.participants ?? [];
    check(participants.includes(ATTACKER), `legacy participants were ${participants}`);
    check(participants.includes(OWN), `legacy participants omitted the mailbox owner: ${participants}`);
    check(participants.includes(OTHER), `legacy participants omitted the real Cc: ${participants}`);
    check(
      !participants.includes(FORGED_VIP) && !participants.includes(FORGED_INTERNAL),
      `legacy participants included a quoted address: ${participants}`,
    );

    const detail = await getGmailMessage("test-token", "legacy-1");
    check(detail.fromEmail === ATTACKER, `legacy message fromEmail was ${detail.fromEmail}`);

    const last = await getGmailThreadLast("test-token", "legacy-thread");
    check(last?.fromEmail === ATTACKER, `legacy thread-last fromEmail was ${last?.fromEmail}`);
  } finally {
    globalThis.fetch = previous;
  }
}
