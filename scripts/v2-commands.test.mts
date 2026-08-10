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
) {
  const c = await pool.query<{ id: string }>(
    `insert into seer.conversations (account_id, provider_conversation_id, subject)
       values ($1, $2, 'S') returning id`,
    [accountId, providerId],
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

  // Valid delete: acts on the whole thread and records a receipt.
  const del = await executeCommand(ctx, { type: "delete", conversationId: cDel, deleteToken: token }, "key-del-1");
  assert.equal(del.ok, true);
  assert.deepEqual(del.processed, ["pc-del-m1"]);

  // Replay returns the same result, marked replayed, without re-acting.
  const replay = await executeCommand(ctx, { type: "delete", conversationId: cDel, deleteToken: token }, "key-del-1");
  assert.equal(replay.replayed, true);
  assert.equal(replay.ok, true);
  const events = await db.pool.query(
    "select count(*)::int as n from seer.events where account_id = $1 and kind = 'mail_trash'",
    [accountId],
  );
  assert.equal(events.rows[0].n, 1, "replay must not record a second action");

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

  // Partial provider failure surfaces on archive (pc-partial has a failing msg).
  const arch = await executeCommand(ctx, { type: "archive", conversationId: cKeep }, "key-arch");
  assert.equal(arch.ok, false);
  assert.deepEqual(arch.failed, ["pc-partial-m2"]);
  assert.deepEqual(arch.processed, ["pc-partial-m1"]);

  // Correction supersedes the model decision and is not second-guessed.
  const corrected = await executeCommand(
    ctx, { type: "correctConversation", conversationId: cKeep, home: "matter", note: "this is live" }, "key-correct",
  );
  assert.equal(corrected.ok, true);
  const now = await currentDecision(cKeep);
  assert.equal(now?.home, "matter");
  assert.equal(now?.modelVersion, "user-correction");

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
