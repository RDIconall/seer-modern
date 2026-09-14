/**
 * Gate: a quiet five minutes must cost a quiet five minutes.
 *
 * Both background crons used to fan out one function invocation per connected
 * mailbox on every tick, whatever the state of that mailbox. A desk with an
 * empty read queue paid an invocation to discover it had nothing to do, and a
 * mailbox whose OAuth had failed paid one — plus a doomed token refresh —
 * twelve times an hour, forever. At company scale that is the whole baseline,
 * and a normal morning's mail reads as a usage spike on top of it.
 *
 * So: the read dispatcher asks the queue which mailboxes are waiting, and the
 * sync dispatcher asks which mailboxes can actually sync. A disconnected
 * mailbox must still be retried on a slow cadence, because a refresh can fail
 * transiently and the account has to heal without the user reconnecting.
 */
import assert from "node:assert/strict";
import { startTestDb } from "./v2-testdb.mts";
import {
  markCredentialsReconnectRequired,
  saveCredentials,
  upsertAccount,
  upsertUser,
} from "../src/lib/v2/db/accounts.ts";
import {
  listAccountsForSync,
  RECONNECT_RETRY_MINUTES,
} from "../src/lib/v2/db/list-accounts.ts";
import { accountIdsNeedingRead } from "../src/lib/v2/intelligence/queue.ts";
import { saveDecision } from "../src/lib/v2/intelligence/repository.ts";
import { asConversationId, type AccountId } from "../src/lib/v2/db/types.ts";
import type { Pool } from "pg";

async function addInbox(
  pool: Pool,
  accountId: AccountId,
  providerId: string,
): Promise<string> {
  const row = await pool.query<{ id: string }>(
    `insert into seer.conversations
       (account_id, provider_conversation_id, subject, folders, last_message_at)
     values ($1, $2, $2, array['inbox'], '2026-08-31T01:00:00Z')
     returning id`,
    [accountId, providerId],
  );
  const id = row.rows[0].id;
  await pool.query(
    `insert into seer.messages
       (account_id, conversation_id, provider_message_id, from_email, to_emails,
        sent_at, body_text, snippet, is_unread, is_outgoing)
     values ($1, $2, $3, 'sender@example.com', array['me@example.com'],
             '2026-08-31T01:00:00Z', 'Body.', 'Body', true, false)`,
    [accountId, id, `${providerId}-m`],
  );
  return id;
}

const db = await startTestDb();
try {
  const userId = await upsertUser("idle-cron@example.com");
  const busy = await upsertAccount({
    userId,
    provider: "google",
    email: "busy@example.com",
  });
  const quiet = await upsertAccount({
    userId,
    provider: "google",
    email: "quiet@example.com",
  });
  const broken = await upsertAccount({
    userId,
    provider: "microsoft",
    email: "broken@example.com",
  });
  const longBroken = await upsertAccount({
    userId,
    provider: "microsoft",
    email: "long-broken@example.com",
  });
  const neverConnected = await upsertAccount({
    userId,
    provider: "google",
    email: "never-connected@example.com",
  });

  // ---- the read dispatcher only wakes mailboxes with mail waiting ----

  await addInbox(db.pool, busy, "busy-1");
  const quietConvo = await addInbox(db.pool, quiet, "quiet-1");
  await saveDecision({
    accountId: quiet,
    conversationId: asConversationId(quietConvo),
    home: "record",
    proposedHome: "record",
    summary: "Already read",
    rationale: "Nothing waiting",
    owner: "nobody",
    vetoReasons: [],
    yields: [],
    evidence: [],
  });

  const waiting = (await accountIdsNeedingRead()).map(String);
  assert.deepEqual(
    waiting,
    [String(busy)],
    "only the mailbox with unread mail may cost a worker invocation",
  );

  await saveDecision({
    accountId: busy,
    conversationId: asConversationId(
      (
        await db.pool.query<{ id: string }>(
          "select id from seer.conversations where account_id = $1",
          [busy],
        )
      ).rows[0].id,
    ),
    home: "record",
    proposedHome: "record",
    summary: "Read on this tick",
    rationale: "Done",
    owner: "nobody",
    vetoReasons: [],
    yields: [],
    evidence: [],
  });

  assert.deepEqual(
    await accountIdsNeedingRead(),
    [],
    "with every queue empty the read tick must start zero workers",
  );

  // ---- the sync dispatcher only wakes mailboxes that can sync ----

  for (const accountId of [busy, quiet, broken, longBroken]) {
    await saveCredentials(accountId, "google", {
      accessToken: "at",
      refreshToken: "rt",
      expiresAt: Date.now() + 3_600_000,
    });
  }
  await markCredentialsReconnectRequired(broken, "invalid_grant");
  await markCredentialsReconnectRequired(longBroken, "invalid_grant");
  await db.pool.query(
    `update seer.oauth_credentials
        set rotated_at = now() - make_interval(mins => $2)
      where account_id = $1`,
    [longBroken, RECONNECT_RETRY_MINUTES + 5],
  );

  const syncable = (await listAccountsForSync()).map((a) => a.email);
  assert.ok(
    syncable.includes("busy@example.com") &&
      syncable.includes("quiet@example.com"),
    "connected mailboxes still sync every tick",
  );
  assert.ok(
    !syncable.includes("broken@example.com"),
    "a mailbox that just failed its refresh must not be retried every tick — " +
      "the worker exists only to fail again",
  );
  assert.ok(
    syncable.includes("long-broken@example.com"),
    "a disconnected mailbox must still be retried on the slow cadence so a " +
      "transient provider failure heals itself",
  );
  assert.ok(
    !syncable.includes("never-connected@example.com"),
    "an account with no credentials at all has nothing to sync",
  );
  void neverConnected;

  console.log("v2-cron-idle: OK");
} finally {
  await db.stop();
}
