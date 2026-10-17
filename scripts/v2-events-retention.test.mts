/**
 * seer.events retention deletes only audit rows older than 90 days.
 * Conversations and other corpus tables stay put.
 */
import assert from "node:assert/strict";
import { startTestDb } from "./v2-testdb.mts";
import { upsertAccount, upsertUser } from "../src/lib/v2/db/accounts.ts";
import {
  EVENTS_RETENTION_MIN_DAYS,
  eventsRetentionDays,
  purgeOldEvents,
} from "../src/lib/v2/events/retention.ts";

assert.equal(eventsRetentionDays({}), EVENTS_RETENTION_MIN_DAYS);
assert.throws(
  () => eventsRetentionDays({ SEER_EVENTS_RETENTION_DAYS: "30" }),
  /90/,
);

const db = await startTestDb();
try {
  const userId = await upsertUser("events-retention@rditrials.com");
  const accountId = await upsertAccount({
    userId,
    provider: "google",
    email: "events-retention@rditrials.com",
  });

  await db.pool.query(
    `insert into seer.conversations (account_id, provider_conversation_id, subject, folders, is_unread)
     values ($1, 'keep-thread', 'keep me', array['inbox'], false)`,
    [accountId],
  );
  await db.pool.query(
    `insert into seer.events (account_id, kind, payload, created_at)
     values
       ($1, 'old_audit', '{}'::jsonb, now() - interval '91 days'),
       ($1, 'recent_audit', '{}'::jsonb, now() - interval '7 days')`,
    [accountId],
  );

  const deleted = await purgeOldEvents(90);
  assert.equal(deleted, 1, "only the 91-day-old event is removed");

  const kinds = await db.pool.query<{ kind: string }>(
    "select kind from seer.events where account_id = $1 order by kind",
    [accountId],
  );
  assert.deepEqual(kinds.rows.map((r) => r.kind), ["recent_audit"]);

  const conversations = await db.pool.query<{ n: number }>(
    "select count(*)::int as n from seer.conversations where account_id = $1",
    [accountId],
  );
  assert.equal(conversations.rows[0].n, 1, "conversations are not purged");

  let refused = false;
  try {
    await purgeOldEvents(30);
  } catch {
    refused = true;
  }
  assert.equal(refused, true, "windows shorter than 90 days are refused");

  console.log("v2-events-retention: OK");
} finally {
  await db.stop();
}
