import assert from "node:assert/strict";
import { startTestDb } from "./v2-testdb.mts";
import { upsertAccount, upsertUser } from "../src/lib/v2/db/accounts.ts";
import { asAccountId, type AccountId } from "../src/lib/v2/db/types.ts";
import type { MailAccount } from "../src/lib/v2/db/accounts.ts";
import { FakeProvider } from "../src/lib/v2/providers/fake.ts";
import { autotriageAccount } from "../src/lib/v2/autotriage/run.ts";
import { setAutoTriageMode } from "../src/lib/v2/autotriage/repository.ts";

const db = await startTestDb();
const prev = process.env.SEER_AUTOTRIAGE;
const prevProp = process.env.SEER_AUTOTRIAGE_PROPOSALS;

async function seedMessage(
  accountId: AccountId,
  providerConv: string,
  providerMsg: string,
  fromEmail: string,
  subject: string,
  opts: { outgoing?: boolean; sentAt?: string } = {},
) {
  const c = await db.pool.query<{ id: string }>(
    `insert into seer.conversations
       (account_id, provider_conversation_id, subject, last_message_at, folders, is_unread)
     values ($1, $2, $3, $4, array['inbox']::text[], false)
     returning id`,
    [accountId, providerConv, subject, opts.sentAt ?? "2026-10-18T00:00:00Z"],
  );
  await db.pool.query(
    `insert into seer.messages
       (account_id, conversation_id, provider_message_id, from_email, sent_at,
        snippet, body_text, is_outgoing)
     values ($1, $2, $3, $4, $5, $6, $6, $7)`,
    [
      accountId,
      c.rows[0].id,
      providerMsg,
      fromEmail,
      opts.sentAt ?? "2026-10-18T00:00:00Z",
      subject,
      opts.outgoing ?? false,
    ],
  );
  return c.rows[0].id;
}

try {
  const userId = await upsertUser("autotriage-run@example.com");
  const accountId = asAccountId(
    await upsertAccount({
      userId,
      provider: "google",
      email: "autotriage-run@example.com",
    }),
  );
  const account: MailAccount = {
    id: accountId,
    userId,
    provider: "google",
    email: "autotriage-run@example.com",
    displayName: null,
    status: "active",
  };
  new FakeProvider({ conversations: [] });

  const junkId = await seedMessage(
    accountId,
    "pc-lab",
    "m-lab",
    "newsletter@labmanager.com",
    "Weekly digest",
  );

  process.env.SEER_AUTOTRIAGE = "dry_run";
  delete process.env.SEER_AUTOTRIAGE_PROPOSALS;
  const dry = await autotriageAccount(account, [junkId]);
  assert.equal(dry.mode, "dry_run");
  assert.equal(dry.logged, 1);
  const dryOutbox = await db.pool.query(
    "select count(*)::int as n from seer.outbox where account_id = $1",
    [accountId],
  );
  assert.equal(dryOutbox.rows[0].n, 0, "dry_run creates no outbox rows");

  process.env.SEER_AUTOTRIAGE = "live";
  await setAutoTriageMode(accountId, "live");
  const liveId = await seedMessage(
    accountId,
    "pc-live",
    "m-live",
    "newsletter@labmanager.com",
    "Live weekly",
  );
  const live = await autotriageAccount(account, [liveId]);
  assert.equal(live.mode, "live");
  const liveOutbox = await db.pool.query<{ idempotency_key: string; command: { type: string } }>(
    "select idempotency_key, command from seer.outbox where account_id = $1",
    [accountId],
  );
  assert.equal(liveOutbox.rows.length, 1);
  assert.equal(liveOutbox.rows[0].idempotency_key, "autotriage:m-live");
  assert.equal(liveOutbox.rows[0].command.type, "trash");

  const again = await autotriageAccount(account, [liveId]);
  assert.equal(again.logged, 0, "second run is idempotent");
  const liveOutbox2 = await db.pool.query(
    "select count(*)::int as n from seer.outbox where account_id = $1",
    [accountId],
  );
  assert.equal(liveOutbox2.rows[0].n, 1);

  process.env.SEER_AUTOTRIAGE = "off";
  const offId = await seedMessage(
    accountId,
    "pc-off",
    "m-off",
    "newsletter@labmanager.com",
    "Off",
  );
  const off = await autotriageAccount(account, [offId]);
  assert.equal(off.mode, "off");
  assert.equal(off.considered, 0);

  process.env.SEER_AUTOTRIAGE = "live";
  const breakerIds: string[] = [];
  for (let i = 0; i < 51; i++) {
    breakerIds.push(
      await seedMessage(
        accountId,
        `pc-br-${i}`,
        `m-br-${i}`,
        "newsletter@labmanager.com",
        `Breaker ${i}`,
      ),
    );
  }
  const beforeBreaker = await db.pool.query(
    "select count(*)::int as n from seer.outbox where account_id = $1",
    [accountId],
  );
  const tripped = await autotriageAccount(account, breakerIds);
  assert.equal(tripped.circuitBreaker, true);
  assert.equal(tripped.mode, "dry_run");
  const afterBreaker = await db.pool.query(
    "select count(*)::int as n from seer.outbox where account_id = $1",
    [accountId],
  );
  assert.equal(
    afterBreaker.rows[0].n,
    beforeBreaker.rows[0].n,
    "circuit breaker must not enqueue deletes",
  );
  const settings = await db.pool.query<{ mode: string }>(
    "select mode from seer.autotriage_settings where account_id = $1",
    [accountId],
  );
  assert.equal(settings.rows[0].mode, "dry_run");

  console.log("v2-autotriage-run: OK");
} finally {
  if (prev === undefined) delete process.env.SEER_AUTOTRIAGE;
  else process.env.SEER_AUTOTRIAGE = prev;
  if (prevProp === undefined) delete process.env.SEER_AUTOTRIAGE_PROPOSALS;
  else process.env.SEER_AUTOTRIAGE_PROPOSALS = prevProp;
  await db.stop();
}
