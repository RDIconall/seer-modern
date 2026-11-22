/**
 * Matter company must come from the sender that authorized promotion.
 *
 * A later From on the same thread is not that sender. These tests sync a real
 * Gmail or Outlook payload (attacker message first in the payload, earlier
 * message first after the provider sorts by time), persist it, and run the
 * scheduled read. They fail while filing still keys the company off the newest
 * From and stores the opening message's codes on that company.
 */
import assert from "node:assert/strict";
import { startTestDb, type TestDb } from "./v2-testdb.mts";
import { upsertUser, upsertAccount } from "../src/lib/v2/db/accounts.ts";
import { syncFolder } from "../src/lib/v2/sync/engine.ts";
import { readBatch } from "../src/lib/v2/intelligence/read-batch.ts";
import { clearContextInputCache } from "../src/lib/v2/intelligence/context-loader.ts";
import { buildInboxView } from "../src/lib/v2/view/build.ts";
import type { ReaderModel } from "../src/lib/v2/intelligence/reader.ts";
import type { AccountId } from "../src/lib/v2/db/types.ts";
import type { MailProvider, ProviderKind } from "../src/lib/v2/providers/types.ts";
import { GmailProvider } from "../src/lib/v2/providers/gmail.ts";
import { OutlookProvider } from "../src/lib/v2/providers/outlook.ts";

function ownEmail(label: string): string {
  return `conall+${label}@rditrials.com`;
}
const OPENING_SENDER = "ada@partnerco.example";
const SAME_COMPANY_SENDER = "bob@partnerco.example";
const INTERNAL_SENDER = "casey@rditrials.com";
const ATTACKER = "pat@northwind-attack.example";
const ATTACKER_COMPANY = "northwind-attack";
const OPENING_COMPANY = "partnerco";
const LATER_SENDER = "sam@elsewhere.example";
const OPENING_CODE = "RD007704";
const MATTER_REF = "Vendor onboarding packet review";
const ATTACKER_MATTER_TITLE = "Vendor onboarding status board";

const OPENING_BODY =
  `The study code ${OPENING_CODE} is on the vendor onboarding packet. Please review it.`;
const ATTACKER_BODY = "Adding a colleague from our side. No study code in this note.";
const LATER_BODY = `Samples for ${OPENING_CODE} leave the dock on Friday. Please confirm.`;

type MailKind = "google" | "microsoft";

const model: ReaderModel = async () => ({
  home: "matter",
  summary: "Vendor onboarding packet needs a decision",
  rationale: "The opening sender asked for a review",
  owner: "you",
  ask: "Review the vendor onboarding packet",
  obligation: false,
  matterRef: MATTER_REF,
  yields: [],
  evidence: [],
});

function b64url(value: string): string {
  return Buffer.from(value, "utf8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function gmailMessage(
  own: string,
  id: string,
  threadId: string,
  sentAt: string,
  from: string,
  subject: string,
  body: string,
) {
  return {
    id,
    threadId,
    snippet: body.slice(0, 40),
    labelIds: ["INBOX", "UNREAD"],
    internalDate: String(Date.parse(sentAt)),
    payload: {
      headers: [
        { name: "From", value: from },
        { name: "To", value: `Conall <${own}>` },
        { name: "Subject", value: subject },
      ],
      mimeType: "text/plain",
      body: { size: body.length, data: b64url(body) },
    },
  };
}

function graphMessage(
  own: string,
  id: string,
  conversationId: string,
  sentAt: string,
  from: string,
  subject: string,
  body: string,
) {
  return {
    id,
    conversationId,
    subject,
    from: { emailAddress: { address: from, name: from } },
    toRecipients: [{ emailAddress: { address: own, name: "Conall" } }],
    ccRecipients: [],
    receivedDateTime: sentAt,
    bodyPreview: body.slice(0, 40),
    body: { contentType: "text", content: body },
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

/**
 * Payload order is newest-first. Gmail and Outlook both sort by sent time
 * before the reader sees the thread, so the attacker becomes the last From.
 */
function poisonedMessages(kind: MailKind, own: string, threadId: string) {
  const openingAt = "2026-08-01T10:00:00.000Z";
  const attackAt = "2026-08-02T10:00:00.000Z";
  if (kind === "google") {
    return [
      gmailMessage(own, `${threadId}-new`, threadId, attackAt, ATTACKER, "Re: Vendor onboarding packet", ATTACKER_BODY),
      gmailMessage(own, `${threadId}-old`, threadId, openingAt, OPENING_SENDER, "Vendor onboarding packet", OPENING_BODY),
    ];
  }
  return [
    graphMessage(own, `${threadId}-new`, threadId, attackAt, ATTACKER, "Re: Vendor onboarding packet", ATTACKER_BODY),
    graphMessage(own, `${threadId}-old`, threadId, openingAt, OPENING_SENDER, "Vendor onboarding packet", OPENING_BODY),
  ];
}

function laterMessages(kind: MailKind, own: string, threadId: string) {
  const sentAt = "2026-08-03T10:00:00.000Z";
  const subject = "Lab shipment window";
  if (kind === "google") {
    return [gmailMessage(own, `${threadId}-m`, threadId, sentAt, LATER_SENDER, subject, LATER_BODY)];
  }
  return [graphMessage(own, `${threadId}-m`, threadId, sentAt, LATER_SENDER, subject, LATER_BODY)];
}

function sameCompanyMessages(kind: MailKind, own: string, threadId: string) {
  const openingAt = "2026-08-01T10:00:00.000Z";
  const replyAt = "2026-08-02T10:00:00.000Z";
  const reply = "Bob from the same company, following up on the packet.";
  if (kind === "google") {
    return [
      gmailMessage(own, `${threadId}-new`, threadId, replyAt, SAME_COMPANY_SENDER, "Re: Vendor onboarding packet", reply),
      gmailMessage(own, `${threadId}-old`, threadId, openingAt, OPENING_SENDER, "Vendor onboarding packet", OPENING_BODY),
    ];
  }
  return [
    graphMessage(own, `${threadId}-new`, threadId, replyAt, SAME_COMPANY_SENDER, "Re: Vendor onboarding packet", reply),
    graphMessage(own, `${threadId}-old`, threadId, openingAt, OPENING_SENDER, "Vendor onboarding packet", OPENING_BODY),
  ];
}

function internalMessages(kind: MailKind, own: string, threadId: string) {
  const openingAt = "2026-08-01T10:00:00.000Z";
  const attackAt = "2026-08-02T10:00:00.000Z";
  if (kind === "google") {
    return [
      gmailMessage(own, `${threadId}-new`, threadId, attackAt, ATTACKER, "Re: Vendor onboarding packet", ATTACKER_BODY),
      gmailMessage(own, `${threadId}-old`, threadId, openingAt, INTERNAL_SENDER, "Vendor onboarding packet", OPENING_BODY),
    ];
  }
  return [
    graphMessage(own, `${threadId}-new`, threadId, attackAt, ATTACKER, "Re: Vendor onboarding packet", ATTACKER_BODY),
    graphMessage(own, `${threadId}-old`, threadId, openingAt, INTERNAL_SENDER, "Vendor onboarding packet", OPENING_BODY),
  ];
}

class ScriptedMailbox {
  threads = new Map<string, unknown[]>();
  /** Conversation ids returned by the next inbox page, in list order. */
  inbox: string[] = [];

  provider(kind: MailKind, own: string): MailProvider {
    const fetchImpl = (async (url: string) => {
      const u = String(url);
      if (kind === "google") {
        const thread = u.match(/\/threads\/([^/?]+)/);
        if (thread) {
          const id = decodeURIComponent(thread[1]);
          return json({ id, messages: this.threads.get(id) ?? [] });
        }
        if (u.includes("/threads?")) {
          return json({
            threads: this.inbox.map((id) => ({ id })),
            resultSizeEstimate: this.inbox.length,
          });
        }
      } else {
        if (u.includes("/mailFolders/inbox?$select=totalItemCount")) {
          return json({ totalItemCount: this.inbox.length });
        }
        if (u.includes("/mailFolders/inbox/messages")) {
          const value = this.inbox.flatMap((id) => {
            const messages = (this.threads.get(id) ?? []) as { id: string; conversationId: string }[];
            // The folder page carries one row per message. The newest row is
            // enough for the adapter to discover the conversation id; the
            // conversation query below returns the whole thread.
            return messages[0] ? [messages[0]] : [];
          });
          return json({ value });
        }
        const filter = decodeURIComponent(u).match(/conversationId eq '([^']+)'/);
        if (u.includes("$filter") && filter) {
          return json({ value: this.threads.get(filter[1]) ?? [] });
        }
      }
      throw new Error(`unexpected ${kind} request ${u}`);
    }) as typeof fetch;
    if (kind === "google") {
      return new GmailProvider({
        accessToken: "test-token",
        accountEmail: own,
        fetchImpl,
      });
    }
    return new OutlookProvider({
      accessToken: "test-token",
      accountEmail: own,
      fetchImpl,
    });
  }
}

async function openAccount(kind: MailKind, own: string): Promise<AccountId> {
  const userId = await upsertUser(own);
  return upsertAccount({
    userId,
    provider: kind,
    email: own,
  });
}

async function markKnown(accountId: AccountId, email: string): Promise<void> {
  const { db } = await import("../src/lib/v2/db/pool.ts");
  await db().query(
    `insert into seer.people (account_id, email, tier, vip)
     values ($1, $2, 'known', false)`,
    [accountId, email],
  );
}

async function seedAttackerMatter(accountId: AccountId): Promise<string> {
  const { db } = await import("../src/lib/v2/db/pool.ts");
  const row = await db().query<{ id: string }>(
    `insert into seer.matters (account_id, title, org_unit)
     values ($1, $2, $3)
     returning id`,
    [accountId, ATTACKER_MATTER_TITLE, ATTACKER_COMPANY],
  );
  return row.rows[0].id;
}

async function syncInbox(
  accountId: AccountId,
  provider: MailProvider,
): Promise<void> {
  const run = await syncFolder(accountId, provider, "inbox", "incremental", {
    maxPages: 1,
  });
  assert.equal(run.coverage.failed, 0, "sync must store the provider thread");
}

async function readInbox(accountId: AccountId, own: string): Promise<void> {
  clearContextInputCache();
  const result = await readBatch(accountId, own, model, { limit: 10, concurrency: 1 });
  if (result.failed > 0) {
    const { db } = await import("../src/lib/v2/db/pool.ts");
    const errors = await db().query<{ payload: unknown }>(
      `select payload from seer.events
        where account_id = $1 and kind = 'read_failed'
        order by id desc limit 3`,
      [accountId],
    );
    assert.fail(`read failed: ${JSON.stringify(errors.rows)}`);
  }
  assert.equal(result.decided, result.attempted);
  assert.ok(result.decided > 0, "the synced thread must be read");
}

async function filedMatter(accountId: AccountId, providerConversationId: string) {
  const { db } = await import("../src/lib/v2/db/pool.ts");
  const row = await db().query<{
    matter_id: string;
    org_unit: string | null;
    title: string;
    home: string;
    codes: string[] | null;
  }>(
    `select m.id as matter_id, m.org_unit, m.title, d.home,
            array_remove(array_agg(distinct mc.code), null) as codes
       from seer.conversations c
       join seer.conversation_decisions d
         on d.conversation_id = c.id and d.is_current
       left join seer.matters m on m.id = d.matter_id
       left join seer.matter_codes mc on mc.matter_id = m.id
      where c.account_id = $1 and c.provider_conversation_id = $2
      group by m.id, m.org_unit, m.title, d.home`,
    [accountId, providerConversationId],
  );
  assert.equal(row.rowCount, 1);
  return row.rows[0];
}

async function messageOrder(accountId: AccountId, providerConversationId: string) {
  const { db } = await import("../src/lib/v2/db/pool.ts");
  const rows = await db().query<{ from_email: string }>(
    `select m.from_email
       from seer.messages m
       join seer.conversations c on c.id = m.conversation_id
      where c.account_id = $1 and c.provider_conversation_id = $2
      order by m.sent_at asc, m.provider_message_id asc`,
    [accountId, providerConversationId],
  );
  return rows.rows.map((row) => row.from_email);
}

const failures: string[] = [];

function expectEqual(actual: unknown, expected: unknown, message: string): void {
  try {
    assert.equal(actual, expected, message);
  } catch (error) {
    failures.push(error instanceof Error ? error.message : String(error));
  }
}

function expectDeepEqual(actual: unknown, expected: unknown, message: string): void {
  try {
    assert.deepEqual(actual, expected, message);
  } catch (error) {
    failures.push(error instanceof Error ? error.message : String(error));
  }
}

function expectOk(value: unknown, message: string): void {
  try {
    assert.ok(value, message);
  } catch (error) {
    failures.push(error instanceof Error ? error.message : String(error));
  }
}

const db: TestDb = await startTestDb();
try {
  // Gmail: known opening sender, attacker replies later. No open matter yet.
  // The new matter's company is the opening sender, and the opening code is
  // stored there. A later letter that repeats the code follows that matter.
  {
    const own = ownEmail("gmail-create");
    const accountId = await openAccount("google", own);
    await markKnown(accountId, OPENING_SENDER);
    const box = new ScriptedMailbox();
    const threadId = "gmail-create";
    box.threads.set(threadId, poisonedMessages("google", own, threadId));
    box.inbox = [threadId];
    const provider = box.provider("google", own);
    await syncInbox(accountId, provider);
    expectDeepEqual(
      await messageOrder(accountId, threadId),
      [OPENING_SENDER, ATTACKER],
      "gmail sync sorts so the attacker is last",
    );
    await readInbox(accountId, own);
    const filed = await filedMatter(accountId, threadId);
    expectEqual(filed.home, "matter", "known opening sender still promotes");
    expectEqual(
      filed.org_unit,
      OPENING_COMPANY,
      "gmail create: company is the opening sender, not the newest From",
    );
    expectOk(
      filed.codes?.includes(OPENING_CODE),
      "opening-message code is stored on the opening sender's matter",
    );
    const attackerRows = await db.pool.query<{ n: number }>(
      `select count(*)::int as n from seer.matters
        where account_id = $1 and org_unit = $2`,
      [accountId, ATTACKER_COMPANY],
    );
    expectEqual(attackerRows.rows[0].n, 0, "gmail create must not insert the attacker's company");

    const laterId = "gmail-later";
    box.threads.set(laterId, laterMessages("google", own, laterId));
    box.inbox = [laterId];
    await syncInbox(accountId, provider);
    await readInbox(accountId, own);
    const later = await filedMatter(accountId, laterId);
    expectEqual(later.home, "matter");
    expectEqual(
      later.matter_id,
      filed.matter_id,
      "later mail that repeats the opening code stays on the opening sender's matter",
    );
    expectEqual(
      later.org_unit,
      OPENING_COMPANY,
      "later mail that repeats the opening code is not filed under the newest sender",
    );

    const view = await buildInboxView(accountId, "google" satisfies ProviderKind);
    const card = view.atlas.find((matter) =>
      matter.conversations.some((row) => row.providerConversationId === threadId),
    );
    expectOk(card, "the live thread is on the work board");
    expectEqual(
      card?.orgUnit,
      OPENING_COMPANY,
      "work board groups the thread under the opening sender's company",
    );
    expectEqual(
      card?.conversations.some((row) => row.providerConversationId === laterId),
      true,
      "the later thread is grouped on that same matter",
    );
  }

  // Outlook: opening sender is inside the mailbox's own domain, so promotion
  // is allowed as internal. A later outside From must not become the company.
  {
    const own = ownEmail("outlook-internal");
    const accountId = await openAccount("microsoft", own);
    const box = new ScriptedMailbox();
    const threadId = "outlook-internal";
    box.threads.set(threadId, internalMessages("microsoft", own, threadId));
    box.inbox = [threadId];
    const provider = box.provider("microsoft", own);
    await syncInbox(accountId, provider);
    expectDeepEqual(
      await messageOrder(accountId, threadId),
      [INTERNAL_SENDER, ATTACKER],
      "outlook sync sorts so the attacker is last",
    );
    await readInbox(accountId, own);
    const filed = await filedMatter(accountId, threadId);
    expectEqual(filed.home, "matter", "internal opening sender still promotes");
    expectEqual(
      filed.org_unit,
      "internal",
      "outlook create: company stays internal when a later From is outside",
    );
    expectOk(filed.codes?.includes(OPENING_CODE));
    const view = await buildInboxView(accountId, "microsoft");
    const card = view.atlas.find((matter) =>
      matter.conversations.some((row) => row.providerConversationId === threadId),
    );
    expectEqual(
      card?.orgUnit,
      "internal",
      "outlook work board groups the thread under internal, not the later From",
    );
  }

  // An open matter already uses the attacker's company, and the generated
  // title shares two informative words with it. The thread must not be
  // linked there, and the opening code must not be saved on it.
  {
    const own = ownEmail("gmail-link");
    const accountId = await openAccount("google", own);
    await markKnown(accountId, OPENING_SENDER);
    const seeded = await seedAttackerMatter(accountId);
    const box = new ScriptedMailbox();
    const threadId = "gmail-link";
    box.threads.set(threadId, poisonedMessages("google", own, threadId));
    box.inbox = [threadId];
    const provider = box.provider("google", own);
    await syncInbox(accountId, provider);
    await readInbox(accountId, own);
    const filed = await filedMatter(accountId, threadId);
    expectEqual(filed.home, "matter");
    try {
      assert.notEqual(
        filed.matter_id,
        seeded,
        "two shared title words must not attach the thread to the attacker's open matter",
      );
    } catch (error) {
      failures.push(error instanceof Error ? error.message : String(error));
    }
    expectEqual(filed.org_unit, OPENING_COMPANY);
    const seededCodes = await db.pool.query<{ code: string }>(
      "select code from seer.matter_codes where matter_id = $1",
      [seeded],
    );
    expectDeepEqual(
      seededCodes.rows,
      [],
      "opening codes are not recorded on the attacker's matter",
    );
    const seededLinks = await db.pool.query<{ n: number }>(
      `select count(*)::int as n from seer.matter_conversations
        where matter_id = $1`,
      [seeded],
    );
    expectEqual(seededLinks.rows[0].n, 0);

    const laterId = "gmail-link-later";
    box.threads.set(laterId, laterMessages("google", own, laterId));
    box.inbox = [laterId];
    await syncInbox(accountId, provider);
    await readInbox(accountId, own);
    const later = await filedMatter(accountId, laterId);
    try {
      assert.notEqual(later.matter_id, seeded);
    } catch (error) {
      failures.push(
        error instanceof Error
          ? `later mail was tied to the attacker's open matter: ${error.message}`
          : String(error),
      );
    }
    expectEqual(later.matter_id, filed.matter_id);
    expectEqual(
      later.org_unit,
      OPENING_COMPANY,
      "later mail that repeats the opening code does not join the attacker's open matter",
    );
  }

  // A later From at the same company as the opening sender is that company's
  // mail. Filing stays on the opening company.
  {
    const own = ownEmail("gmail-same");
    const accountId = await openAccount("google", own);
    await markKnown(accountId, OPENING_SENDER);
    const box = new ScriptedMailbox();
    const threadId = "gmail-same-company";
    box.threads.set(threadId, sameCompanyMessages("google", own, threadId));
    box.inbox = [threadId];
    await syncInbox(accountId, box.provider("google", own));
    expectDeepEqual(await messageOrder(accountId, threadId), [
      OPENING_SENDER,
      SAME_COMPANY_SENDER,
    ]);
    await readInbox(accountId, own);
    const filed = await filedMatter(accountId, threadId);
    expectEqual(filed.home, "matter");
    expectEqual(
      filed.org_unit,
      OPENING_COMPANY,
      "a later From at the opening company stays on that company",
    );
    expectOk(filed.codes?.includes(OPENING_CODE));
  }

  if (failures.length > 0) {
    assert.fail(`${failures.length} filing check(s) failed\n${failures.join("\n")}`);
  }
} finally {
  await db.stop();
}
