/**
 * seer_bot can read verdicts and learning signals, cannot write them, and
 * cannot touch the underlying events/outbox tables.
 */
import assert from "node:assert/strict";
import { startTestDb } from "./v2-testdb.mts";
import { upsertAccount, upsertUser } from "../src/lib/v2/db/accounts.ts";
import { saveDecision } from "../src/lib/v2/intelligence/repository.ts";
import { asConversationId } from "../src/lib/v2/db/types.ts";
import { composeVerdict } from "../src/lib/v2/intelligence/verdict.ts";

const db = await startTestDb();
try {
  const tables = await db.pool.query<{ table_name: string }>(
    `select table_name from information_schema.views
      where table_schema = 'seer'
        and table_name in ('bot_learning_signals', 'bot_conversation_verdicts')`,
  );
  assert.equal(tables.rowCount, 2, "both bot views must exist");

  const userId = await upsertUser("learn@rditrials.com");
  const accountId = await upsertAccount({
    userId,
    provider: "microsoft",
    email: "learn@rditrials.com",
  });
  const convo = await db.pool.query<{ id: string }>(
    `insert into seer.conversations
       (account_id, provider_conversation_id, subject, folders)
     values ($1, 'p-learn', 'Renewal invoice', array['inbox']::text[])
     returning id`,
    [accountId],
  );
  const conversationId = asConversationId(convo.rows[0].id);
  await db.pool.query(
    `insert into seer.messages
       (account_id, conversation_id, provider_message_id, from_email, sent_at)
     values ($1, $2, 'm1', 'billing@vendor.com', now())`,
    [accountId, conversationId],
  );

  const verdict = composeVerdict({
    home: "record",
    owner: "you",
    ask: "Pay the renewal",
    summary: "Annual renewal",
    obligation: true,
    dueDate: "2026-12-13",
    senderName: "Vendor",
    senderEmail: "billing@vendor.com",
    senderTier: "unknown",
    senderVip: false,
    inContacts: false,
    writtenTo: false,
    meeting: null,
    inviteAnswered: false,
    weSpokeLast: false,
    behavior: null,
    amount: 140,
    usualAmount: 140,
    usualLabel: "same as last year's renewal",
    anomalousAmount: false,
    candidateMatterTitle: null,
    freeSlot: null,
    now: new Date("2026-11-14T17:00:00Z"),
  });
  await saveDecision({
    accountId,
    conversationId,
    home: "record",
    proposedHome: "record",
    summary: "Annual renewal",
    rationale: "keep",
    owner: "you",
    ask: "Pay the renewal",
    vetoReasons: [],
    yields: [],
    evidence: [],
    verdict,
  });

  await db.pool.query(
    `insert into seer.events (account_id, kind, payload)
     values ($1, 'user_teach_sender', $2::jsonb)`,
    [
      accountId,
      JSON.stringify({ email: "billing@vendor.com", instruction: "ignore" }),
    ],
  );
  await db.pool.query(
    `insert into seer.outbox (account_id, command, idempotency_key, status)
     values ($1, $2::jsonb, 'ob-1', 'done'),
            ($1, $3::jsonb, 'ob-2', 'cancelled')`,
    [
      accountId,
      JSON.stringify({ type: "trash", conversationId, byUser: true }),
      JSON.stringify({ type: "archive", conversationId }),
    ],
  );
  await db.pool.query(
    `insert into seer.training_events (account_id, conversation_id, kind, payload)
     values ($1, $2, 'triage', '{"outcome":"delete"}'::jsonb)`,
    [accountId, conversationId],
  );

  const bot = await db.pool.connect();
  try {
    await bot.query("set role seer_bot");
    const verdicts = await bot.query<{ care: string; why: string }>(
      `select care, why from seer.bot_conversation_verdicts
        where account_id = $1`,
      [accountId],
    );
    assert.equal(verdicts.rows[0].care, "needs_you");
    assert.match(verdicts.rows[0].why, /Pay by Dec 13/i);

    const signals = await bot.query<{ signal_kind: string; source: string }>(
      `select signal_kind, source from seer.bot_learning_signals
        where account_id = $1
        order by source, signal_kind`,
      [accountId],
    );
    const kinds = signals.rows.map((r) => `${r.source}:${r.signal_kind}`);
    assert.ok(kinds.includes("event:user_teach_sender"));
    assert.ok(kinds.includes("outbox:outbox_trash"));
    assert.ok(kinds.includes("outbox:outbox_archive"));
    assert.ok(kinds.includes("training:training_triage"));

    const undo = await bot.query<{ instruction: string | null }>(
      `select instruction from seer.bot_learning_signals
        where account_id = $1 and signal_kind = 'outbox_archive'`,
      [accountId],
    );
    assert.equal(undo.rows[0].instruction, "undo");

    for (const table of ["events", "outbox", "training_events", "user_profiles"]) {
      const priv = await bot.query<{ allowed: boolean }>(
        `select has_table_privilege(current_user, 'seer.${table}', 'select') as allowed`,
      );
      assert.equal(
        priv.rows[0].allowed,
        false,
        `seer_bot must not SELECT seer.${table} directly`,
      );
      const write = await bot.query<{ allowed: boolean }>(
        `select has_table_privilege(current_user, 'seer.${table}', 'insert') as allowed`,
      );
      assert.equal(
        write.rows[0].allowed,
        false,
        `seer_bot must not INSERT seer.${table}`,
      );
    }

    let wrote = false;
    try {
      await bot.query(
        `insert into seer.bot_learning_signals
           (account_id, signal_id, source, signal_kind, created_at, payload)
         values ($1, 'x', 'event', 'nope', now(), '{}'::jsonb)`,
        [accountId],
      );
      wrote = true;
    } catch {
      wrote = false;
    }
    assert.equal(wrote, false, "the learning view is not writable");

    let mutatedEvents = false;
    try {
      await bot.query("delete from seer.events");
      mutatedEvents = true;
    } catch {
      mutatedEvents = false;
    }
    assert.equal(mutatedEvents, false, "seer_bot must not write events");
  } finally {
    await bot.query("reset role");
    bot.release();
  }

  console.log("v2-learning-signals: OK");
} finally {
  await db.stop();
}
