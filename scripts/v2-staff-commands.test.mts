import assert from "node:assert/strict";
import { startTestDb } from "./v2-testdb.mts";
import { upsertAccount, upsertUser } from "../src/lib/v2/db/accounts.ts";
import { executeCommand } from "../src/lib/v2/commands/execute.ts";
import { asConversationId, type AccountId } from "../src/lib/v2/db/types.ts";
import { insertProposal, loadStaffView } from "../src/lib/v2/staff/repository.ts";
import { tasksFromCsv } from "../src/lib/v2/staff/seed.ts";
import { upsertSeedTask } from "../src/lib/v2/staff/repository.ts";
import { promises as fs } from "node:fs";
import path from "node:path";

async function addConversation(
  pool: import("pg").Pool,
  accountId: AccountId,
  providerId: string,
) {
  const c = await pool.query<{ id: string }>(
    `insert into seer.conversations
       (account_id, provider_conversation_id, subject, folders, is_unread)
     values ($1, $2, 'Promo', $3::text[], false)
     returning id`,
    [accountId, providerId, ["inbox"]],
  );
  return asConversationId(c.rows[0].id);
}

const db = await startTestDb();
try {
  const userId = await upsertUser("staff-cmd@example.com");
  const accountId = await upsertAccount({
    userId,
    provider: "google",
    email: "staff-cmd@example.com",
  });
  const ctx = { accountId };

  const created = await executeCommand(
    ctx,
    {
      type: "createBotTask",
      title: "Pull Divvy expenses",
      botSlug: "chief-of-staff",
      hisWords: "login to divvy",
    },
    "staff-create-1",
  );
  assert.equal(created.ok, true, created.error);
  const taskId = String(created.detail?.taskId);
  assert.match(taskId, /^[0-9a-f-]{36}$/);

  const replay = await executeCommand(
    ctx,
    { type: "createBotTask", title: "Pull Divvy expenses" },
    "staff-create-1",
  );
  assert.equal(replay.replayed, true);

  const blocked = await executeCommand(
    ctx,
    { type: "updateBotTask", taskId, status: "blocked" },
    "staff-update-1",
  );
  assert.equal(blocked.ok, true);

  const commented = await executeCommand(
    ctx,
    { type: "commentBotTask", taskId, body: "Need the pre-merger login." },
    "staff-comment-1",
  );
  assert.equal(commented.ok, true);

  const chat = await executeCommand(
    ctx,
    { type: "postBotMessage", body: "Kick off Divvy now." },
    "staff-chat-1",
  );
  assert.equal(chat.ok, true);

  const empty = await executeCommand(
    ctx,
    { type: "createBotTask", title: "   " },
    "staff-empty",
  );
  assert.equal(empty.ok, false);

  const view = await loadStaffView(accountId, { taskId });
  const task = view.tasks.find((row) => row.id === taskId);
  assert.ok(task);
  assert.equal(task?.status, "blocked");
  assert.equal(task?.botName, "Chief of staff");
  assert.ok(task?.events.some((event) => event.kind === "comment"));
  assert.equal(view.generalMessages.length, 1);
  assert.equal(view.generalMessages[0].author, "user");

  const conversationId = await addConversation(db.pool, accountId, "pc-promo");
  const proposal = await insertProposal({
    accountId,
    conversationId,
    providerConversationId: "pc-promo",
    senderEmail: "deals@shop.test",
    subject: "40% off",
    action: "delete",
    rationale: "Promotional blast",
  });
  assert.equal(proposal.status, "pending");
  const before = await db.pool.query(
    "select count(*)::int as n from seer.outbox where account_id = $1",
    [accountId],
  );
  assert.equal(before.rows[0].n, 0, "nothing executes while the proposal is pending");

  const rejected = await executeCommand(
    ctx,
    { type: "decideTriageProposal", proposalId: proposal.id, decision: "rejected" },
    "staff-reject-1",
  );
  assert.equal(rejected.ok, true);
  const afterReject = await db.pool.query(
    "select count(*)::int as n from seer.outbox where account_id = $1",
    [accountId],
  );
  assert.equal(afterReject.rows[0].n, 0, "reject does not trash mail");

  const proposal2 = await insertProposal({
    accountId,
    conversationId,
    providerConversationId: "pc-promo",
    action: "delete",
    rationale: "Still junk",
  });
  const approved = await executeCommand(
    ctx,
    { type: "decideTriageProposal", proposalId: proposal2.id, decision: "approved" },
    "staff-approve-1",
  );
  assert.equal(approved.ok, true, approved.error);
  assert.equal(approved.optimistic, true);
  assert.match(approved.outboxId ?? "", /^[0-9a-f-]{36}$/);
  const outbox = await db.pool.query<{ command: { type: string } }>(
    "select command from seer.outbox where id = $1",
    [approved.outboxId],
  );
  assert.equal(outbox.rows[0].command.type, "trash");
  const folders = await db.pool.query<{ folders: string[] }>(
    "select folders from seer.conversations where id = $1",
    [conversationId],
  );
  assert.ok(folders.rows[0].folders.includes("trash"));
  assert.ok(!folders.rows[0].folders.includes("inbox"));

  const csv = await fs.readFile(
    path.join(process.cwd(), "fixtures", "bot_tasks.csv"),
    "utf8",
  );
  const rows = tasksFromCsv(csv);
  for (const row of rows) {
    await upsertSeedTask({
      accountId,
      botSlug: row.botSlug,
      botName: row.botName,
      externalKey: row.externalKey,
      title: row.title,
      status: row.status,
      priority: row.priority,
      hisWords: row.hisWords,
      currentState: row.currentState,
      nextAction: row.nextAction,
      notes: row.nextAction,
      source: "bot",
    });
  }
  const again = await upsertSeedTask({
    accountId,
    botSlug: rows[0].botSlug,
    botName: rows[0].botName,
    externalKey: rows[0].externalKey,
    title: rows[0].title,
    status: rows[0].status,
    priority: 1,
    hisWords: rows[0].hisWords,
    currentState: rows[0].currentState,
    nextAction: rows[0].nextAction,
    source: "bot",
  });
  const seeded = await loadStaffView(accountId);
  const b01 = seeded.tasks.filter((task) => task.externalKey === "B01");
  assert.equal(b01.length, 1, "seed is idempotent on external_key");
  assert.equal(again.externalKey, "B01");
  assert.equal(
    seeded.tasks.filter((task) => task.externalKey).length,
    27,
  );

  console.log("v2-staff-commands: OK");
} finally {
  await db.stop();
}
