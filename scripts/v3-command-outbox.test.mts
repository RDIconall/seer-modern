/**
 * Task 5 gate: mutation commands enqueue to the outbox instead of calling the
 * provider synchronously; delete-token verification stays before enqueue; undo
 * cancels pending rows; fresh mailbox/triage views reflect optimistic state.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { startTestDb } from "./v2-testdb.mts";
import { upsertUser, upsertAccount } from "../src/lib/v2/db/accounts.ts";
import { saveDecision } from "../src/lib/v2/intelligence/repository.ts";
import { signDecisionToken } from "../src/lib/v2/view/token.ts";
import { executeCommand } from "../src/lib/v2/commands/execute.ts";
import { cancelPending } from "../src/lib/v3/outbox/repository.ts";
import { buildInboxView } from "../src/lib/v2/view/build.ts";
import { getMailboxView } from "../src/lib/v3/mailbox/repository.ts";
import { FakeProvider } from "../src/lib/v2/providers/fake.ts";
import { asConversationId, type AccountId } from "../src/lib/v2/db/types.ts";
import type { Message } from "../src/lib/v2/providers/types.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));

function fakeMsg(id: string): Message & { folder: "inbox" } {
  return {
    providerMessageId: id,
    from: { email: "s@x.com" },
    to: [],
    cc: [],
    sentAt: "2026-08-01T10:00:00Z",
    snippet: "",
    bodyHtml: "<p>b</p>",
    bodyText: "b",
    isUnread: false,
    isOutgoing: false,
    attachments: [],
    folder: "inbox",
  } as Message & { folder: "inbox" };
}

async function seedConversation(
  pool: import("pg").Pool,
  accountId: AccountId,
  providerId: string,
  folders: string[] = ["inbox"],
) {
  const c = await pool.query<{ id: string }>(
    `insert into seer.conversations
       (account_id, provider_conversation_id, subject, last_message_at, folders, is_unread)
     values ($1, $2, 'Subject', now(), $3::text[], false)
     returning id`,
    [accountId, providerId, folders],
  );
  return asConversationId(c.rows[0].id);
}

function trackMutations(provider: FakeProvider) {
  let calls = 0;
  const original = provider.mutateConversation.bind(provider);
  provider.mutateConversation = async (...args) => {
    calls += 1;
    return original(...args);
  };
  return () => calls;
}

const db = await startTestDb();
try {
  const userId = await upsertUser("cmd-outbox@example.com");
  const accountId = await upsertAccount({
    userId,
    provider: "google",
    email: "cmd-outbox@example.com",
  });

  const provider = new FakeProvider({
    conversations: [
      { providerConversationId: "pc-arch", subject: "A", messages: [fakeMsg("m-arch")] },
      { providerConversationId: "pc-del", subject: "D", messages: [fakeMsg("m-del")] },
      { providerConversationId: "pc-rest", subject: "R", messages: [fakeMsg("m-rest")] },
      { providerConversationId: "pc-unread", subject: "U", messages: [fakeMsg("m-unread")] },
      { providerConversationId: "pc-send", subject: "S", messages: [fakeMsg("m-send")] },
    ],
  });
  const ctx = { accountId, provider };
  const mutationCalls = trackMutations(provider);
  const cArch = await seedConversation(db.pool, accountId, "pc-arch", ["inbox"]);
  const cDel = await seedConversation(db.pool, accountId, "pc-del", ["inbox"]);
  const cRest = await seedConversation(db.pool, accountId, "pc-rest", ["trash"]);
  const cUnread = await seedConversation(db.pool, accountId, "pc-unread", ["inbox"]);
  const cSend = await seedConversation(db.pool, accountId, "pc-send", ["inbox"]);

  // Queueable mutations do not need a provider instance (and therefore do not
  // need an access-token refresh). Outbound commands still fail visibly when
  // that dependency is unavailable.
  const noProviderArchive = await executeCommand(
    { accountId, provider: undefined },
    { type: "archive", conversationId: cArch },
    "key-no-provider-archive",
  );
  assert.equal(noProviderArchive.ok, true);
  assert.equal(noProviderArchive.optimistic, true);
  const noProviderSend = await executeCommand(
    { accountId, provider: undefined },
    { type: "send", to: ["x@y.com"], subject: "Unavailable", bodyHtml: "<p>x</p>" },
    "key-no-provider-send",
  );
  assert.equal(noProviderSend.ok, false);
  assert.match(noProviderSend.error ?? "", /provider/i);

  const deleteDecision = await saveDecision({
    accountId,
    conversationId: cDel,
    home: "delete",
    proposedHome: "delete",
    summary: "N",
    rationale: "disposable",
    owner: "nobody",
    vetoReasons: [],
    yields: [],
    evidence: [],
  });
  const deleteToken = signDecisionToken(deleteDecision.id, cDel);

  // Archive enqueues optimistically — no synchronous provider mutation.
  const arch = await executeCommand(ctx, { type: "archive", conversationId: cArch }, "key-arch");
  assert.equal(arch.ok, true);
  assert.equal(arch.optimistic, true);
  assert.match(arch.outboxId ?? "", /^[0-9a-f-]{36}$/);
  assert.equal(mutationCalls(), 0, "archive must not call provider synchronously");
  const archRow = await db.pool.query<{ folders: string[] }>(
    "select folders from seer.conversations where id = $1",
    [cArch],
  );
  assert.deepEqual(archRow.rows[0].folders.sort(), ["archive"]);
  const archOutbox = await db.pool.query(
    "select status from seer.outbox where id = $1",
    [arch.outboxId],
  );
  assert.equal(archOutbox.rows[0].status, "pending");

  // Delete verifies token before enqueue and maps to trash outbox command.
  const del = await executeCommand(
    ctx,
    { type: "delete", conversationId: cDel, deleteToken },
    "key-del",
  );
  assert.equal(del.ok, true);
  assert.equal(del.optimistic, true);
  assert.equal(mutationCalls(), 0, "delete must not call provider synchronously");
  const delRow = await db.pool.query<{ folders: string[] }>(
    "select folders from seer.conversations where id = $1",
    [cDel],
  );
  assert.deepEqual(delRow.rows[0].folders.sort(), ["trash"]);
  const delOutbox = await db.pool.query<{ command: { type: string } }>(
    "select command from seer.outbox where id = $1",
    [del.outboxId],
  );
  assert.equal(delOutbox.rows[0].command.type, "trash");

  // Invalid delete token is rejected before any outbox row is created.
  const beforeBad = await db.pool.query<{ n: number }>(
    "select count(*)::int as n from seer.outbox where account_id = $1",
    [accountId],
  );
  const bad = await executeCommand(
    ctx,
    { type: "delete", conversationId: cDel, deleteToken: "garbage.token.here" },
    "key-bad",
  );
  assert.equal(bad.ok, false);
  assert.match(bad.error ?? "", /invalid delete token/);
  const afterBad = await db.pool.query<{ n: number }>(
    "select count(*)::int as n from seer.outbox where account_id = $1",
    [accountId],
  );
  assert.equal(afterBad.rows[0].n, beforeBad.rows[0].n, "invalid delete must not enqueue");

  // Restore and markUnread enqueue without provider calls.
  const restore = await executeCommand(ctx, { type: "restore", conversationId: cRest }, "key-rest");
  assert.equal(restore.ok, true);
  assert.equal(restore.optimistic, true);
  const restRow = await db.pool.query<{ folders: string[] }>(
    "select folders from seer.conversations where id = $1",
    [cRest],
  );
  assert.deepEqual(restRow.rows[0].folders.sort(), ["inbox"]);

  const unread = await executeCommand(
    ctx,
    { type: "markUnread", conversationId: cUnread },
    "key-unread",
  );
  assert.equal(unread.ok, true);
  assert.equal(unread.optimistic, true);
  const unreadRow = await db.pool.query<{ is_unread: boolean }>(
    "select is_unread from seer.conversations where id = $1",
    [cUnread],
  );
  assert.equal(unreadRow.rows[0].is_unread, true);
  assert.equal(mutationCalls(), 0, "restore/markUnread must not call provider synchronously");

  // Idempotent replay returns the same outbox row.
  const replay = await executeCommand(ctx, { type: "archive", conversationId: cArch }, "key-arch");
  assert.equal(replay.replayed, true);
  assert.equal(replay.outboxId, arch.outboxId);

  // Send/reply remain synchronous provider calls.
  const send = await executeCommand(
    ctx,
    { type: "send", to: ["x@y.com"], subject: "Hi", bodyHtml: "<p>hi</p>" },
    "key-send",
  );
  assert.equal(send.ok, true);
  assert.equal(send.optimistic, undefined);
  assert.ok(send.detail?.providerMessageId);

  const reply = await executeCommand(
    ctx,
    { type: "reply", providerConversationId: "pc-send", all: false, bodyHtml: "<p>re</p>" },
    "key-reply",
  );
  assert.equal(reply.ok, true);
  assert.equal(reply.optimistic, undefined);

  // Correction and teaching stay on the direct path.
  const corrected = await executeCommand(
    ctx,
    { type: "correctConversation", conversationId: cArch, home: "matter", note: "live" },
    "key-correct",
  );
  assert.equal(corrected.ok, true);
  assert.equal(corrected.optimistic, undefined);

  const taught = await executeCommand(
    ctx,
    { type: "teachSender", email: "boss@example.com", instruction: "vip" },
    "key-teach",
  );
  assert.equal(taught.ok, true);
  assert.equal(taught.optimistic, undefined);

  // A corpus UUID from another account cannot write a decision or event.
  const otherUser = await upsertUser("cmd-outbox-other@example.com");
  const otherAccount = await upsertAccount({
    userId: otherUser,
    provider: "google",
    email: "cmd-outbox-other@example.com",
  });
  const foreignConversation = await seedConversation(
    db.pool,
    otherAccount,
    "pc-foreign",
    ["inbox"],
  );
  const foreignBefore = await db.pool.query<{ decisions: number; events: number }>(
    `select
       (select count(*)::int from seer.conversation_decisions where conversation_id = $1) as decisions,
       (select count(*)::int from seer.events where account_id = $2) as events`,
    [foreignConversation, otherAccount],
  );
  const crossAccount = await executeCommand(
    ctx,
    { type: "correctConversation", conversationId: foreignConversation, home: "matter" },
    "key-cross-account",
  );
  assert.equal(crossAccount.ok, false);
  const foreignAfter = await db.pool.query<{ decisions: number; events: number }>(
    `select
       (select count(*)::int from seer.conversation_decisions where conversation_id = $1) as decisions,
       (select count(*)::int from seer.events where account_id = $2) as events`,
    [foreignConversation, otherAccount],
  );
  assert.deepEqual(foreignAfter.rows[0], foreignBefore.rows[0]);

  // Undo cancels pending and reverts optimistic state without a provider call.
  const undoTarget = await seedConversation(db.pool, accountId, "pc-undo", ["inbox"]);
  const pending = await executeCommand(
    ctx,
    { type: "archive", conversationId: undoTarget },
    "key-undo",
  );
  assert.equal(pending.ok, true);
  const undone = await cancelPending(accountId, pending.outboxId!);
  assert.equal(undone, true);
  assert.equal(mutationCalls(), 0, "undo must not call provider");
  const undoneRow = await db.pool.query<{ folders: string[] }>(
    "select folders from seer.conversations where id = $1",
    [undoTarget],
  );
  assert.deepEqual(undoneRow.rows[0].folders.sort(), ["inbox"]);
  const cancelled = await db.pool.query<{ status: string }>(
    "select status from seer.outbox where id = $1",
    [pending.outboxId],
  );
  assert.equal(cancelled.rows[0].status, "cancelled");

  // Fresh mailbox and triage views reflect optimistic corpus state.
  const mailbox = await getMailboxView(accountId, "inbox", 50);
  const inboxIds = mailbox.rows.map((r) => r.conversationId);
  assert.ok(!inboxIds.includes(cArch), "archived thread leaves inbox mailbox view");
  assert.ok(inboxIds.includes(cRest), "restored thread appears in inbox mailbox view");
  assert.ok(inboxIds.includes(cUnread), "markUnread thread stays in inbox list");

  const triage = await buildInboxView(accountId, "google");
  assert.ok(triage.asOf, "triage view builds after optimistic mutations");
  assert.equal(typeof triage.coverage.stored, "number");
  assert.ok(
    !triage.safeToDelete.some((r) => r.conversationId === cArch),
    "archived thread is not listed for deletion",
  );

  // Undo route exists and delegates to cancelPending for authenticated callers.
  const undoRoute = readFileSync(
    path.join(HERE, "../src/app/api/v3/outbox/[id]/undo/route.ts"),
    "utf8",
  );
  assert.match(undoRoute, /cancelPending/);
  assert.match(undoRoute, /getActiveV2Account/);
  assert.match(undoRoute, /buildInboxView/);
  assert.match(undoRoute, /getMailboxView/);
  assert.match(undoRoute, /originAllowed/);
  assert.match(undoRoute, /production/);
  const commandRoute = readFileSync(
    path.join(HERE, "../src/app/api/v2/commands/route.ts"),
    "utf8",
  );
  assert.match(commandRoute, /originAllowed/);
  assert.match(commandRoute, /providerFor/);
  assert.match(commandRoute, /send|reply|forward/);

  console.log("v3-command-outbox: OK");
} finally {
  await db.stop();
}
