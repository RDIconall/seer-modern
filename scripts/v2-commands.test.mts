/**
 * Task 10 gate: the command bus. Delete needs a valid current decision token,
 * replays are idempotent, partial provider failures surface, stale/invalid
 * tokens are rejected, corrections supersede the model, and teachings persist.
 */
import assert from "node:assert/strict";
import { startTestDb } from "./v2-testdb.mts";
import { upsertUser, upsertAccount } from "../src/lib/v2/db/accounts.ts";
import { saveDecision, currentDecision } from "../src/lib/v2/intelligence/repository.ts";
import { signDecisionToken } from "../src/lib/v2/view/token.ts";
import { executeCommand } from "../src/lib/v2/commands/execute.ts";
import { FakeProvider } from "../src/lib/v2/providers/fake.ts";
import { asConversationId, type AccountId } from "../src/lib/v2/db/types.ts";
import type { Message } from "../src/lib/v2/providers/types.ts";

function fakeMsg(id: string, fail = false): Message & { folder: "inbox"; failMutation?: boolean } {
  return {
    providerMessageId: id, from: { email: "s@x.com" }, to: [], cc: [],
    sentAt: "2026-08-01T10:00:00Z", snippet: "", bodyHtml: "<p>b</p>", bodyText: "b",
    isUnread: true, isOutgoing: false, attachments: [], folder: "inbox", failMutation: fail,
  } as Message & { folder: "inbox"; failMutation?: boolean };
}

async function addConversation(
  pool: import("pg").Pool, accountId: AccountId, providerId: string,
  folders: string[] = ["inbox"],
) {
  const c = await pool.query<{ id: string }>(
    `insert into seer.conversations
       (account_id, provider_conversation_id, subject, folders, is_unread)
     values ($1, $2, 'S', $3::text[], false)
     returning id`,
    [accountId, providerId, folders],
  );
  return asConversationId(c.rows[0].id);
}

const db = await startTestDb();
try {
  const userId = await upsertUser("cmd@example.com");
  const accountId = await upsertAccount({ userId, provider: "google", email: "cmd@example.com" });

  const provider = new FakeProvider({
    conversations: [
      { providerConversationId: "pc-del", subject: "S", messages: [fakeMsg("pc-del-m1")] },
      { providerConversationId: "pc-partial", subject: "S", messages: [fakeMsg("pc-partial-m1"), fakeMsg("pc-partial-m2", true)] },
    ],
  });
  const ctx = { accountId, provider };

  const cDel = await addConversation(db.pool, accountId, "pc-del");
  const decision = await saveDecision({
    accountId, conversationId: cDel, home: "delete", proposedHome: "delete",
    summary: "N", rationale: "disposable", owner: "nobody", vetoReasons: [], yields: [], evidence: [],
  });
  const token = signDecisionToken(decision.id, cDel);

  // Valid delete enqueues trash optimistically — provider drain happens later.
  const del = await executeCommand(ctx, { type: "delete", conversationId: cDel, deleteToken: token }, "key-del-1");
  assert.equal(del.ok, true);
  assert.equal(del.optimistic, true);
  assert.match(del.outboxId ?? "", /^[0-9a-f-]{36}$/);
  const delFolders = await db.pool.query<{ folders: string[] }>(
    "select folders from seer.conversations where id = $1",
    [cDel],
  );
  assert.deepEqual(delFolders.rows[0].folders.sort(), ["trash"]);

  // Replay returns the same result, marked replayed, without re-enqueueing.
  const replay = await executeCommand(ctx, { type: "delete", conversationId: cDel, deleteToken: token }, "key-del-1");
  assert.equal(replay.replayed, true);
  assert.equal(replay.ok, true);
  assert.equal(replay.outboxId, del.outboxId);
  const outboxRows = await db.pool.query(
    "select count(*)::int as n from seer.outbox where account_id = $1 and idempotency_key = 'key-del-1'",
    [accountId],
  );
  assert.equal(outboxRows.rows[0].n, 1, "replay must not create a second outbox row");

  // Invalid token is rejected.
  const bad = await executeCommand(ctx, { type: "delete", conversationId: cDel, deleteToken: "garbage.token.here" }, "key-bad");
  assert.equal(bad.ok, false);
  assert.match(bad.error ?? "", /invalid delete token/);

  // Stale token: a new decision supersedes; the old token no longer matches.
  const superseded = await saveDecision({
    accountId, conversationId: cDel, home: "delete", proposedHome: "delete",
    summary: "N2", rationale: "still disposable", owner: "nobody", vetoReasons: [], yields: [], evidence: [],
  });
  assert.notEqual(superseded.id, decision.id);
  const stale = await executeCommand(ctx, { type: "delete", conversationId: cDel, deleteToken: token }, "key-stale");
  assert.equal(stale.ok, false);
  assert.match(stale.error ?? "", /stale decision/);

  // A decision that no longer authorizes delete is refused even with a fresh token.
  const cKeep = await addConversation(db.pool, accountId, "pc-partial");
  const keepDecision = await saveDecision({
    accountId, conversationId: cKeep, home: "undecided", proposedHome: "delete",
    summary: "K", rationale: "vetoed", owner: "nobody", vetoReasons: ["known_sender"], yields: [], evidence: [],
  });
  const keepToken = signDecisionToken(keepDecision.id, cKeep);
  const refused = await executeCommand(ctx, { type: "delete", conversationId: cKeep, deleteToken: keepToken }, "key-refuse");
  assert.equal(refused.ok, false);
  assert.match(refused.error ?? "", /no longer authorizes delete/);

  // Archive enqueues optimistically; provider partial failure is handled at drain.
  const arch = await executeCommand(ctx, { type: "archive", conversationId: cKeep }, "key-arch");
  assert.equal(arch.ok, true);
  assert.equal(arch.optimistic, true);
  const archFolders = await db.pool.query<{ folders: string[] }>(
    "select folders from seer.conversations where id = $1",
    [cKeep],
  );
  assert.deepEqual(archFolders.rows[0].folders.sort(), ["archive"]);

  // Correction supersedes the model decision and is not second-guessed.
  const corrected = await executeCommand(
    ctx, { type: "correctConversation", conversationId: cKeep, home: "matter", note: "this is live" }, "key-correct",
  );
  assert.equal(corrected.ok, true);
  const now = await currentDecision(accountId, cKeep);
  assert.equal(now?.home, "matter");
  assert.equal(now?.modelVersion, "user-correction");
  assert.ok(now?.matterId, "making a matter must put it on a real Atlas concern");
  assert.equal(corrected.detail?.matterId, now?.matterId);
  const autoLink = await db.pool.query(
    `select 1 from seer.matter_conversations
      where matter_id = $1 and conversation_id = $2`,
    [now?.matterId, cKeep],
  );
  assert.equal(autoLink.rowCount, 1, "Seer's relation sweep records the link");

  // A long-press can put mail on an exact existing matter.
  const exactConversation = await addConversation(
    db.pool,
    accountId,
    "pc-exact-matter",
  );
  const exact = await executeCommand(
    ctx,
    {
      type: "correctConversation",
      conversationId: exactConversation,
      home: "matter",
      matterId: now?.matterId,
      note: "added to an existing matter",
    },
    "key-exact-matter",
  );
  assert.equal(exact.ok, true);
  assert.equal(
    (await currentDecision(accountId, exactConversation))?.matterId,
    now?.matterId,
  );

  // Or force a new, user-named matter even when Seer sees a relation.
  const newConversation = await addConversation(
    db.pool,
    accountId,
    "pc-new-matter",
  );
  const created = await executeCommand(
    ctx,
    {
      type: "correctConversation",
      conversationId: newConversation,
      home: "matter",
      matterTitle: "User named concern",
      createMatter: true,
    },
    "key-new-matter",
  );
  assert.equal(created.ok, true);
  assert.notEqual(created.detail?.matterId, now?.matterId);
  assert.equal(created.detail?.matterTitle, "User named concern");

  // Triage archive/delete are classifier corrections as well as provider
  // mutations. Plain mailbox actions elsewhere do not carry this meaning.
  const triageArchiveId = await addConversation(
    db.pool,
    accountId,
    "pc-triage-archive",
  );
  const triageArchived = await executeCommand(
    ctx,
    {
      type: "triageConversation",
      conversationId: triageArchiveId,
      destination: "archive",
    },
    "key-triage-archive",
  );
  assert.equal(triageArchived.ok, true);
  assert.ok(triageArchived.outboxId);
  const archivedDecision = await currentDecision(accountId, triageArchiveId);
  assert.equal(archivedDecision?.home, "record");
  assert.equal(archivedDecision?.modelVersion, "user-correction");

  const triageDeleteId = await addConversation(
    db.pool,
    accountId,
    "pc-triage-delete",
  );
  const triageDeleted = await executeCommand(
    ctx,
    {
      type: "triageConversation",
      conversationId: triageDeleteId,
      destination: "delete",
    },
    "key-triage-delete",
  );
  assert.equal(triageDeleted.ok, true);
  assert.ok(triageDeleted.outboxId);
  const deletedDecision = await currentDecision(accountId, triageDeleteId);
  assert.equal(deletedDecision?.home, "delete");
  assert.equal(deletedDecision?.modelVersion, "user-correction");

  // Teaching a VIP persists a user-sourced person.
  const taught = await executeCommand(
    ctx, { type: "teachSender", email: "boss@example.com", instruction: "vip" }, "key-teach",
  );
  assert.equal(taught.ok, true);
  const vip = await db.pool.query(
    "select vip, vip_source from seer.people where account_id = $1 and email = 'boss@example.com'",
    [accountId],
  );
  assert.equal(vip.rows[0].vip, true);
  assert.equal(vip.rows[0].vip_source, "user");

  console.log("v2-commands: OK");
} finally {
  await db.stop();
}
