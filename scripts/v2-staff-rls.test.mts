/**
 * seer_bot must only see Conall's (allowlisted) mailbox, must not SELECT
 * message bodies / matters, and must not mark triage proposals approved
 * or executed — that is Conall's Atlas action, enforced in the database.
 */
import assert from "node:assert/strict";
import { startTestDb } from "./v2-testdb.mts";
import { upsertAccount, upsertUser } from "../src/lib/v2/db/accounts.ts";

const CONALL = "70122bd2-0c14-49db-b2c7-48111828fb68";

const db = await startTestDb();
try {
  const conallUser = await upsertUser("conall-rls@rditrials.com");
  await db.pool.query(
    `insert into seer.mail_accounts (id, user_id, provider, email)
     values ($1, $2, 'google', 'conall-rls@rditrials.com')
     on conflict (id) do nothing`,
    [CONALL, conallUser],
  );
  await db.pool.query(
    `insert into seer.bot_allowed_accounts (account_id) values ($1)
     on conflict do nothing`,
    [CONALL],
  );

  const otherUser = await upsertUser("other-rls@example.com");
  const otherAccount = await upsertAccount({
    userId: otherUser,
    provider: "google",
    email: "other-rls@example.com",
  });

  const bot = await db.pool.query<{ id: string }>(
    "select id from seer.bots where slug = 'chief-of-staff'",
  );
  const botId = bot.rows[0].id;

  await db.pool.query(
    `insert into seer.conversations (account_id, provider_conversation_id, subject, folders, is_unread)
     values ($1, 'conall-thread', 'Conall mail', array['inbox'], false),
            ($2, 'other-thread', 'Other mail', array['inbox'], false)`,
    [CONALL, otherAccount],
  );
  const convs = await db.pool.query<{ id: string; provider_conversation_id: string }>(
    "select id, provider_conversation_id from seer.conversations where provider_conversation_id in ('conall-thread','other-thread')",
  );
  const conallConv = convs.rows.find((r) => r.provider_conversation_id === "conall-thread")!.id;
  const otherConv = convs.rows.find((r) => r.provider_conversation_id === "other-thread")!.id;

  await db.pool.query(
    `insert into seer.messages (account_id, conversation_id, provider_message_id, sent_at, from_email, body_text)
     values ($1, $2, 'm-conall', now(), 'a@b.c', 'secret conall'),
            ($3, $4, 'm-other', now(), 'x@y.z', 'secret other')`,
    [CONALL, conallConv, otherAccount, otherConv],
  );

  const botClient = await db.pool.connect();
  await botClient.query("set role seer_bot");
  try {
    const mailboxes = await botClient.query<{ email: string }>(
      "select email from seer.mail_accounts",
    );
    assert.deepEqual(
      mailboxes.rows.map((r) => r.email).sort(),
      ["conall-rls@rditrials.com"],
      "seer_bot must not list other mailboxes",
    );

    const threads = await botClient.query<{ provider_conversation_id: string }>(
      "select provider_conversation_id from seer.conversations",
    );
    assert.deepEqual(
      threads.rows.map((r) => r.provider_conversation_id),
      ["conall-thread"],
      "seer_bot must not see another account's conversations",
    );

    const canSelectMessages = await botClient.query<{ allowed: boolean }>(
      "select has_table_privilege(current_user, 'seer.messages', 'select') as allowed",
    );
    assert.equal(
      canSelectMessages.rows[0].allowed,
      false,
      "seer_bot must not SELECT seer.messages",
    );
    const canSelectMatters = await botClient.query<{ allowed: boolean }>(
      "select has_table_privilege(current_user, 'seer.matters', 'select') as allowed",
    );
    assert.equal(
      canSelectMatters.rows[0].allowed,
      false,
      "seer_bot must not SELECT seer.matters",
    );

    await botClient.query(
      `insert into seer.bot_tasks (account_id, bot_id, title, source)
       values ($1, $2, 'Allowed task', 'bot')`,
      [CONALL, botId],
    );

    let otherTaskDenied = false;
    try {
      await botClient.query(
        `insert into seer.bot_tasks (account_id, bot_id, title, source)
         values ($1, $2, 'Spy task', 'bot')`,
        [otherAccount, botId],
      );
    } catch {
      otherTaskDenied = true;
    }
    assert.equal(otherTaskDenied, true, "seer_bot cannot insert tasks for another account");

    const pending = await botClient.query<{ id: string }>(
      `insert into seer.triage_proposals
         (account_id, bot_id, conversation_id, action, status)
       values ($1, $2, $3, 'archive', 'pending')
       returning id`,
      [CONALL, botId, conallConv],
    );
    const proposalId = pending.rows[0].id;

    let approvedDenied = false;
    try {
      await botClient.query(
        `update seer.triage_proposals set status = 'approved', decided_by = 'bot'
          where id = $1`,
        [proposalId],
      );
    } catch {
      approvedDenied = true;
    }
    assert.equal(
      approvedDenied,
      true,
      "seer_bot must not set triage_proposals.status to approved",
    );

    let executedDenied = false;
    try {
      await botClient.query(
        `update seer.triage_proposals set status = 'executed', decided_by = 'bot'
          where id = $1`,
        [proposalId],
      );
    } catch {
      executedDenied = true;
    }
    assert.equal(
      executedDenied,
      true,
      "seer_bot must not set triage_proposals.status to executed",
    );

    await botClient.query(
      `update seer.triage_proposals set status = 'rejected', decided_by = 'bot'
        where id = $1`,
      [proposalId],
    );
  } finally {
    await botClient.query("reset role");
    botClient.release();
  }

  console.log("v2-staff-rls: OK");
} finally {
  await db.stop();
}
