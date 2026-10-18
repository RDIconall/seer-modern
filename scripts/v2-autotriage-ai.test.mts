import assert from "node:assert/strict";
import { startTestDb } from "./v2-testdb.mts";
import { upsertAccount, upsertUser } from "../src/lib/v2/db/accounts.ts";
import { asAccountId, type AccountId } from "../src/lib/v2/db/types.ts";
import type { MailAccount } from "../src/lib/v2/db/accounts.ts";
import { autotriageAccount } from "../src/lib/v2/autotriage/run.ts";
import {
  setAiEnabled,
  setAutoTriageMode,
} from "../src/lib/v2/autotriage/repository.ts";
import type { AutoTriageAiCaller } from "../src/lib/v2/autotriage/types.ts";

const db = await startTestDb();
const prev = process.env.SEER_AUTOTRIAGE;
const prevProp = process.env.SEER_AUTOTRIAGE_PROPOSALS;

async function seedMessage(
  accountId: AccountId,
  providerConv: string,
  providerMsg: string,
  fromEmail: string,
  subject: string,
  opts: { outgoingTo?: string } = {},
) {
  const c = await db.pool.query<{ id: string }>(
    `insert into seer.conversations
       (account_id, provider_conversation_id, subject, last_message_at, folders, is_unread)
     values ($1, $2, $3, now(), array['inbox']::text[], false)
     returning id`,
    [accountId, providerConv, subject],
  );
  await db.pool.query(
    `insert into seer.messages
       (account_id, conversation_id, provider_message_id, from_email, sent_at,
        snippet, body_text, is_outgoing)
     values ($1, $2, $3, $4, now(), $5, $5, false)`,
    [accountId, c.rows[0].id, providerMsg, fromEmail, subject],
  );
  if (opts.outgoingTo) {
    await db.pool.query(
      `insert into seer.messages
         (account_id, conversation_id, provider_message_id, from_email, to_emails,
          sent_at, snippet, body_text, is_outgoing)
       values ($1, $2, $3, $4, $5, now(), 're', 're', true)`,
      [
        accountId,
        c.rows[0].id,
        `${providerMsg}-out`,
        "autotriage-ai@example.com",
        [opts.outgoingTo],
      ],
    );
  }
  return c.rows[0].id;
}

try {
  const userId = await upsertUser("autotriage-ai@example.com");
  const accountId = asAccountId(
    await upsertAccount({
      userId,
      provider: "google",
      email: "autotriage-ai@example.com",
    }),
  );
  const account: MailAccount = {
    id: accountId,
    userId,
    provider: "google",
    email: "autotriage-ai@example.com",
    displayName: null,
    status: "active",
  };

  process.env.SEER_AUTOTRIAGE = "live";
  process.env.SEER_AUTOTRIAGE_PROPOSALS = "1";
  await setAutoTriageMode(accountId, "live");
  await setAiEnabled(accountId, true);

  const low = await seedMessage(
    accountId,
    "pc-low",
    "m-low",
    "stranger@newco.io",
    "Quick question",
  );
  const lowCaller: AutoTriageAiCaller = async () => ({
    category: "newsletter",
    confidence: 0.89,
    reason: "looks like a blast",
  });
  await autotriageAccount(account, [low], { aiCaller: lowCaller });
  const lowLog = await db.pool.query<{ action: string; proposal_id: string | null }>(
    `select action, proposal_id from seer.autotriage_log
      where provider_message_id = 'm-low'`,
  );
  assert.equal(lowLog.rows[0].action, "review");
  assert.ok(lowLog.rows[0].proposal_id, "0.89 must become a proposal");
  const lowOut = await db.pool.query(
    "select 1 from seer.outbox where idempotency_key = 'autotriage:m-low'",
  );
  assert.equal(lowOut.rowCount, 0);

  const auto = await seedMessage(
    accountId,
    "pc-auto",
    "m-auto",
    "noreply@newco.io",
    "Your weekly roundup",
  );
  const autoCaller: AutoTriageAiCaller = async () => ({
    category: "newsletter",
    confidence: 0.95,
    reason: "newsletter",
  });
  await autotriageAccount(account, [auto], { aiCaller: autoCaller });
  const autoLog = await db.pool.query<{ action: string }>(
    `select action from seer.autotriage_log where provider_message_id = 'm-auto'`,
  );
  assert.equal(autoLog.rows[0].action, "delete");
  const autoOut = await db.pool.query(
    "select 1 from seer.outbox where idempotency_key = 'autotriage:m-auto'",
  );
  assert.equal((autoOut.rowCount ?? 0) > 0, true);

  const human = await seedMessage(
    accountId,
    "pc-human",
    "m-human",
    "pat.q@gmail.com",
    "Quick question",
  );
  const humanCaller: AutoTriageAiCaller = async () => ({
    category: "newsletter",
    confidence: 0.99,
    reason: "model is overconfident",
  });
  await autotriageAccount(account, [human], { aiCaller: humanCaller });
  const humanLog = await db.pool.query<{ action: string }>(
    `select action from seer.autotriage_log where provider_message_id = 'm-human'`,
  );
  assert.equal(humanLog.rows[0].action, "review");
  const humanOut = await db.pool.query(
    "select 1 from seer.outbox where idempotency_key = 'autotriage:m-human'",
  );
  assert.equal(humanOut.rowCount, 0, "freemail/corresponded humans must not auto-delete");

  const corr = await seedMessage(
    accountId,
    "pc-corr",
    "m-corr",
    "pat@newco.io",
    "Quick question",
    { outgoingTo: "pat@newco.io" },
  );
  await autotriageAccount(account, [corr], { aiCaller: humanCaller });
  const corrLog = await db.pool.query<{ action: string }>(
    `select action from seer.autotriage_log where provider_message_id = 'm-corr'`,
  );
  assert.equal(corrLog.rows[0].action, "keep");
  const corrOut = await db.pool.query(
    "select 1 from seer.outbox where idempotency_key = 'autotriage:m-corr'",
  );
  assert.equal(corrOut.rowCount, 0);

  console.log("v2-autotriage-ai: OK");
} finally {
  if (prev === undefined) delete process.env.SEER_AUTOTRIAGE;
  else process.env.SEER_AUTOTRIAGE = prev;
  if (prevProp === undefined) delete process.env.SEER_AUTOTRIAGE_PROPOSALS;
  else process.env.SEER_AUTOTRIAGE_PROPOSALS = prevProp;
  await db.stop();
}
