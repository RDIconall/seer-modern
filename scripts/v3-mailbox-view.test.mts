/**
 * Task 3 gate: corpus-backed mailbox lists project sender, subject, unread,
 * snippet, attachments, and current decision metadata with folder pagination.
 */
import assert from "node:assert/strict";
import { startTestDb } from "./v2-testdb.mts";
import { upsertUser, upsertAccount } from "../src/lib/v2/db/accounts.ts";
import { saveDecision } from "../src/lib/v2/intelligence/repository.ts";
import { conversationsNeedingRead } from "../src/lib/v2/intelligence/queue.ts";
import { getMailboxView } from "../src/lib/v3/mailbox/repository.ts";
import { parseMailboxLimit } from "../src/lib/v3/mailbox/limit.ts";
import { asConversationId, type AccountId } from "../src/lib/v2/db/types.ts";

async function seedConversation(
  pool: import("pg").Pool,
  accountId: AccountId,
  providerId: string,
  folder: "inbox" | "sent" | "trash",
  subject: string,
  sentAt: string,
  opts: { outgoing?: boolean; unread?: boolean; snippet?: string; attachments?: string[] } = {},
) {
  const c = await pool.query<{ id: string }>(
    `insert into seer.conversations
       (account_id, provider_conversation_id, subject, last_message_at, folders, is_unread)
     values ($1, $2, $3, $4, array[$5]::text[], $6)
     returning id`,
    [accountId, providerId, subject, sentAt, folder, opts.unread ?? false],
  );
  await pool.query(
    `insert into seer.messages
       (account_id, conversation_id, provider_message_id, from_email, from_name,
        to_emails, sent_at, snippet, is_unread, is_outgoing, attachment_names)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
    [
      accountId,
      c.rows[0].id,
      `${providerId}-m1`,
      opts.outgoing ? "me@example.com" : "alice@example.com",
      opts.outgoing ? "Me" : "Alice",
      [opts.outgoing ? "bob@example.com" : "me@example.com"],
      sentAt,
      opts.snippet ?? "hello",
      opts.unread ?? false,
      opts.outgoing ?? false,
      opts.attachments ?? [],
    ],
  );
  return asConversationId(c.rows[0].id);
}

const db = await startTestDb();
try {
  const userId = await upsertUser("mailbox@example.com");
  const accountId = await upsertAccount({
    userId,
    provider: "google",
    email: "mailbox@example.com",
  });

  const matter = await db.pool.query<{ id: string }>(
    "insert into seer.matters (account_id, title, org_unit) values ($1, 'Deal Alpha', 'sales') returning id",
    [accountId],
  );
  const matterId = matter.rows[0].id;

  const inboxNew = await seedConversation(
    db.pool,
    accountId,
    "p-new",
    "inbox",
    "New inbox thread",
    "2026-08-10T12:00:00Z",
    { unread: true, snippet: "needs read", attachments: ["brief.pdf"] },
  );
  const inboxOld = await seedConversation(
    db.pool,
    accountId,
    "p-old",
    "inbox",
    "Older inbox thread",
    "2026-08-08T12:00:00Z",
    { unread: false },
  );
  await seedConversation(
    db.pool,
    accountId,
    "p-sent",
    "sent",
    "Outgoing note",
    "2026-08-09T12:00:00Z",
    { outgoing: true, snippet: "sent body" },
  );
  await seedConversation(
    db.pool,
    accountId,
    "p-trash",
    "trash",
    "Deleted thread",
    "2026-08-07T12:00:00Z",
  );

  await saveDecision({
    accountId,
    conversationId: inboxNew,
    home: "matter",
    proposedHome: "matter",
    summary: "Negotiation underway",
    rationale: "active",
    owner: "you",
    matterId,
    vetoReasons: [],
    yields: [],
    evidence: [],
    priority: 80,
    dueDate: "2026-08-15",
  });

  // The older thread is left the user to decide, so the ledger should count it.
  await saveDecision({
    accountId,
    conversationId: inboxOld,
    home: "undecided",
    proposedHome: "delete",
    summary: "Unclear",
    rationale: "vetoed",
    owner: "nobody",
    vetoReasons: ["personal_greeting"],
    yields: [],
    evidence: [],
  });

  const inbox = await getMailboxView(accountId, "inbox", 10);
  assert.equal(inbox.folder, "inbox");
  assert.equal(inbox.total, 2);
  // needsYou is the whole-folder undecided count, not a page-local tally.
  assert.equal(inbox.needsYou, 1, "the ledger counts undecided mail across the inbox");
  assert.equal(inbox.rows.length, 2);
  assert.equal(inbox.rows[0].subject, "New inbox thread");
  assert.equal(inbox.rows[0].senderDisplayName, "Alice");
  assert.equal(inbox.rows[0].isUnread, true);
  assert.equal(inbox.rows[0].snippet, "needs read");
  assert.deepEqual(inbox.rows[0].attachments, ["brief.pdf"]);
  assert.equal(inbox.rows[0].decisionSummary, "Negotiation underway");
  assert.equal(inbox.rows[0].priority, 80);
  assert.equal(inbox.rows[0].dueDate, "2026-08-15");
  assert.equal(inbox.rows[0].matterTitle, "Deal Alpha");
  assert.ok(!inbox.rows.some((r) => r.subject === "Deleted thread"));

  const triage = await getMailboxView(accountId, "inbox", 10, undefined, "triage");
  assert.equal(triage.total, 1, "mail already promoted to Atlas is not counted in Triage");
  assert.equal(triage.rows.length, 1);
  assert.equal(triage.rows[0].subject, "Older inbox thread");
  assert.ok(
    !triage.rows.some((row) => row.matterTitle),
    "Atlas matters must not be duplicated in the action queue",
  );

  const page = await getMailboxView(accountId, "inbox", 1);
  assert.equal(page.rows.length, 1);
  assert.ok(page.nextCursor, "limit+1 pagination must expose nextCursor");
  const page2 = await getMailboxView(accountId, "inbox", 1, page.nextCursor!);
  assert.equal(page2.rows.length, 1);
  assert.equal(page2.rows[0].subject, "Older inbox thread");

  const sent = await getMailboxView(accountId, "sent", 10);
  assert.equal(sent.total, 1);
  assert.equal(sent.rows[0].subject, "Outgoing note");
  assert.equal(sent.rows[0].senderDisplayName, "To Bob");

  // Outgoing latest + read → not bold even when older messages are unread.
  const answeredId = await seedConversation(
    db.pool,
    accountId,
    "p-answered",
    "inbox",
    "Replied thread",
    "2026-08-12T12:00:00Z",
    { unread: true, outgoing: false },
  );
  await db.pool.query(
    `insert into seer.messages
       (account_id, conversation_id, provider_message_id, from_email, from_name,
        to_emails, sent_at, snippet, is_unread, is_outgoing, attachment_names)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
    [
      accountId,
      answeredId,
      "p-answered-m2",
      "me@example.com",
      "Me",
      ["may.yau@example.com"],
      "2026-08-13T12:00:00Z",
      "my reply",
      false,
      true,
      [],
    ],
  );
  await db.pool.query(
    `update seer.conversations set last_message_at = $2, is_unread = true where id = $1`,
    [answeredId, "2026-08-13T12:00:00Z"],
  );
  const answered = await getMailboxView(accountId, "inbox", 10);
  const answeredRow = answered.rows.find((r) => r.subject === "Replied thread");
  assert.ok(answeredRow, "answered thread appears in inbox");
  assert.equal(answeredRow!.senderDisplayName, "To May Yau");
  assert.equal(answeredRow!.isUnread, false, "answered thread must not stay bold");

  // Stale conversation stamp must not bury a newer latest message.
  const staleId = await seedConversation(
    db.pool,
    accountId,
    "p-stale",
    "inbox",
    "Fresh reply stale stamp",
    "2026-08-01T12:00:00Z",
    { unread: false },
  );
  await db.pool.query(
    `insert into seer.messages
       (account_id, conversation_id, provider_message_id, from_email, sent_at, snippet, is_unread, is_outgoing)
     values ($1, $2, $3, 'alice@example.com', $4, 'newest', false, false)`,
    [accountId, staleId, "p-stale-m2", "2026-08-14T12:00:00Z"],
  );
  const sorted = await getMailboxView(accountId, "inbox", 10);
  assert.equal(
    sorted.rows[0].subject,
    "Fresh reply stale stamp",
    "newest message time must sort first even when last_message_at lags",
  );

  const trash = await getMailboxView(accountId, "trash", 10);
  assert.equal(trash.total, 1);
  assert.equal(trash.rows[0].subject, "Deleted thread");

  const inboxUnread = await seedConversation(
    db.pool,
    accountId,
    "p-queue",
    "inbox",
    "Unread without decision",
    "2026-08-11T12:00:00Z",
    { unread: true },
  );

  const queue = await conversationsNeedingRead(accountId, 50);
  assert.ok(queue.includes(inboxUnread), "inbox conversation may enter read queue");
  const sentOnly = await db.pool.query<{ id: string }>(
    `select id from seer.conversations where account_id = $1 and provider_conversation_id = 'p-sent'`,
    [accountId],
  );
  assert.ok(
    !queue.includes(asConversationId(sentOnly.rows[0].id)),
    "sent-only conversations must not enter read queue",
  );

  assert.equal(parseMailboxLimit(null), 50);
  assert.equal(parseMailboxLimit(""), 50);
  assert.equal(parseMailboxLimit("nope"), 50);
  assert.equal(parseMailboxLimit("10"), 10);
  assert.equal(parseMailboxLimit("999"), 200);
  assert.equal(parseMailboxLimit("0"), 1);

  const sharedAt = "2026-08-10T12:00:00Z";
  const tieUserId = await upsertUser("tie@example.com");
  const tieAccountId = await upsertAccount({
    userId: tieUserId,
    provider: "google",
    email: "tie@example.com",
  });
  for (let i = 0; i < 4; i++) {
    const row = await db.pool.query<{ id: string }>(
      `insert into seer.conversations
         (account_id, provider_conversation_id, subject, last_message_at, folders, is_unread)
       values ($1, $2, $3, $4, array['inbox']::text[], false)
       returning id`,
      [tieAccountId, `p-tie-${i}`, `Tie ${i}`, sharedAt],
    );
    await db.pool.query(
      `insert into seer.messages
         (account_id, conversation_id, provider_message_id, from_email, sent_at, snippet, is_unread, is_outgoing)
       values ($1, $2, $3, 'tie@example.com', $4, 'tie', false, false)`,
      [tieAccountId, row.rows[0].id, `p-tie-${i}-m1`, sharedAt],
    );
  }

  const seen = new Set<string>();
  let cursor: string | undefined;
  for (let pageNum = 0; pageNum < 10; pageNum++) {
    const page = await getMailboxView(tieAccountId, "inbox", 1, cursor);
    if (page.rows.length === 0) break;
    const id = page.rows[0].conversationId;
    assert.ok(!seen.has(id), `conversation ${id} must appear only once across pages`);
    seen.add(id);
    cursor = page.nextCursor ?? undefined;
    if (!cursor) break;
  }
  assert.equal(seen.size, 4, "all tied-timestamp rows must paginate without skips");

  console.log("v3-mailbox-view: OK");
} finally {
  await db.stop();
}
