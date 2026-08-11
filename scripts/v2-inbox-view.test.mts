/**
 * Task 9 gate: the inbox view is the single projection. One conversation → one
 * home; only delete rows carry a signed token; matter-linked yields ride on the
 * matter; undecided rows are never deletable; coverage reconciles.
 */
import assert from "node:assert/strict";
import { startTestDb } from "./v2-testdb.mts";
import { upsertUser, upsertAccount } from "../src/lib/v2/db/accounts.ts";
import { saveDecision } from "../src/lib/v2/intelligence/repository.ts";
import { buildInboxView } from "../src/lib/v2/view/build.ts";
import { verifyDecisionToken } from "../src/lib/v2/view/token.ts";
import { asConversationId, type AccountId } from "../src/lib/v2/db/types.ts";

async function addConversation(
  pool: import("pg").Pool,
  accountId: AccountId,
  providerId: string,
  subject: string,
  fromEmail: string,
) {
  const c = await pool.query<{ id: string }>(
    `insert into seer.conversations (account_id, provider_conversation_id, subject, last_message_at)
       values ($1, $2, $3, now()) returning id`,
    [accountId, providerId, subject],
  );
  await pool.query(
    `insert into seer.messages (account_id, conversation_id, provider_message_id, from_email, sent_at)
       values ($1, $2, $3, $4, now())`,
    [accountId, c.rows[0].id, `${providerId}-m1`, fromEmail],
  );
  return asConversationId(c.rows[0].id);
}

const db = await startTestDb();
try {
  const userId = await upsertUser("view@example.com");
  const accountId = await upsertAccount({ userId, provider: "google", email: "view@example.com" });

  // Provider total for coverage.
  await db.pool.query(
    "insert into seer.sync_state (account_id, cursor, provider_total) values ($1, null, 4)",
    [accountId],
  );

  const matterRow = await db.pool.query<{ id: string }>(
    "insert into seer.matters (account_id, title, org_unit) values ($1, 'Roche anti-TPO', 'sales') returning id",
    [accountId],
  );
  const matterId = matterRow.rows[0].id;

  const cMatter = await addConversation(db.pool, accountId, "p-matter", "Pricing", "buyer@roche.com");
  const cRecord = await addConversation(db.pool, accountId, "p-record", "Invoice", "billing@x.com");
  const cDelete = await addConversation(db.pool, accountId, "p-delete", "Newsletter", "news@x.com");
  const cUndecided = await addConversation(db.pool, accountId, "p-undecided", "Maybe", "who@x.com");

  await saveDecision({
    accountId, conversationId: cMatter, home: "matter", proposedHome: "matter",
    summary: "Live pricing negotiation", rationale: "ongoing", owner: "you",
    matterId, vetoReasons: [],
    yields: [{ kind: "matter_connection", matterRef: "Roche anti-TPO", headline: "Pricing moved" }],
    evidence: [],
  });
  await saveDecision({
    accountId, conversationId: cRecord, home: "record", proposedHome: "record",
    summary: "Invoice", rationale: "keep", owner: "nobody", vetoReasons: [], yields: [], evidence: [],
  });
  await saveDecision({
    accountId, conversationId: cDelete, home: "delete", proposedHome: "delete",
    summary: "Newsletter", rationale: "disposable", owner: "nobody", vetoReasons: [],
    yields: [{ kind: "worth_reading", headline: "An article" }], evidence: [],
  });
  await saveDecision({
    accountId, conversationId: cUndecided, home: "undecided", proposedHome: "delete",
    summary: "Unclear", rationale: "vetoed", owner: "nobody", vetoReasons: ["known_sender"],
    yields: [], evidence: [],
  });

  const view = await buildInboxView(accountId, "google");

  // One home each.
  assert.equal(view.atlas.length, 1);
  assert.equal(view.atlas[0].conversations.length, 1);
  assert.equal(view.atlas[0].matterId, matterId);
  assert.equal(view.atlas[0].yields[0].kind, "matter_connection");
  assert.equal(view.records.length, 1);
  assert.equal(view.safeToDelete.length, 1);
  assert.equal(view.undecided.length, 1);

  // Only the delete row carries a valid signed token.
  const token = view.safeToDelete[0].deleteToken;
  const verified = verifyDecisionToken(token);
  assert.ok(verified, "delete token must verify");
  assert.equal(verified?.conversationId, cDelete);

  // A tampered token does not verify.
  assert.equal(verifyDecisionToken(token.slice(0, -2) + "xx"), null);

  // The undecided row has no delete affordance (it's not in safeToDelete).
  assert.ok(!view.safeToDelete.some((r) => r.conversationId === cUndecided));

  // Native URLs target the exact conversation.
  assert.match(view.safeToDelete[0].nativeUrl, /mail\.google\.com.*p-delete/);

  // worth_reading surfaces.
  assert.equal(view.worthReading.length, 1);

  // Each triage row is filed under the sender's counterparty, server-side, the
  // same way matters get their org unit. This is what Triage groups by.
  assert.equal(view.safeToDelete[0].category, "X", "delete row filed by sender org");
  assert.equal(view.records[0].category, "X", "record row filed by sender org");
  assert.equal(view.undecided[0].category, "X", "undecided row filed by sender org");
  // The matter conversation from buyer@roche.com is filed under Roche.
  assert.equal(view.atlas[0].conversations[0].category, "Roche");
  // A sender on the account's own domain is "Internal", freemail is "Other".
  const cInternal = await addConversation(db.pool, accountId, "p-int", "Team note", "colleague@example.com");
  const cFree = await addConversation(db.pool, accountId, "p-free", "Hi", "someone@gmail.com");
  await saveDecision({
    accountId, conversationId: cInternal, home: "record", proposedHome: "record",
    summary: "note", rationale: "keep", owner: "nobody", vetoReasons: [], yields: [], evidence: [],
  });
  await saveDecision({
    accountId, conversationId: cFree, home: "delete", proposedHome: "delete",
    summary: "hi", rationale: "disposable", owner: "nobody", vetoReasons: [], yields: [], evidence: [],
  });
  const view2 = await buildInboxView(accountId, "google");
  const internalRow = view2.records.find((r) => r.conversationId === cInternal);
  const freeRow = view2.safeToDelete.find((r) => r.conversationId === cFree);
  assert.equal(internalRow?.category, "Internal", "own-domain sender is Internal");
  assert.equal(freeRow?.category, "Other", "freemail sender falls into Other");

  // Coverage reconciles: 4 stored, 3 read (matter/record/delete), 1 pending (undecided).
  assert.equal(view.coverage.providerTotal, 4);
  assert.equal(view.coverage.stored, 4);
  assert.equal(view.coverage.read, 3);
  assert.equal(view.coverage.pending, 1);

  console.log("v2-inbox-view: OK");
} finally {
  await db.stop();
}
