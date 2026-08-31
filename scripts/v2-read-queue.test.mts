/**
 * Gate: the read cron cannot stall one desk behind another, and a conversation
 * that burns model calls without producing a decision cannot be retried every
 * five minutes.
 */
import assert from "node:assert/strict";
import { startTestDb } from "./v2-testdb.mts";
import { upsertAccount, upsertUser } from "../src/lib/v2/db/accounts.ts";
import { listAccountsForRead } from "../src/lib/v2/db/list-accounts.ts";
import { conversationsNeedingRead } from "../src/lib/v2/intelligence/queue.ts";
import { loadContextInput } from "../src/lib/v2/intelligence/context-loader.ts";
import { saveDecision } from "../src/lib/v2/intelligence/repository.ts";
import {
  READ_TICK_ACCOUNT_LIMIT,
  runReadTick,
} from "../src/lib/v2/intelligence/read-tick.ts";
import { asConversationId, type AccountId } from "../src/lib/v2/db/types.ts";
import type { ReadResult } from "../src/lib/v2/intelligence/schema.ts";
import type { Pool } from "pg";

const archive: ReadResult = {
  home: "record",
  summary: "Reference email",
  rationale: "No live work; worth retaining",
  owner: "nobody",
  ask: "nothing — informational",
  obligation: false,
  yields: [],
  evidence: [],
};

async function addInbox(
  pool: Pool,
  accountId: AccountId,
  providerId: string,
  lastMessageAt: string,
): Promise<string> {
  const row = await pool.query<{ id: string }>(
    `insert into seer.conversations
       (account_id, provider_conversation_id, subject, folders, last_message_at)
     values ($1, $2, $2, array['inbox'], $3)
     returning id`,
    [accountId, providerId, lastMessageAt],
  );
  const id = row.rows[0].id;
  await pool.query(
    `insert into seer.messages
       (account_id, conversation_id, provider_message_id, from_email, to_emails,
        sent_at, body_text, snippet, is_unread, is_outgoing)
     values ($1, $2, $3, 'sender@example.com', array['me@example.com'],
             $4, 'Complete body text.', 'Complete body', true, false)`,
    [accountId, id, `${providerId}-m`, lastMessageAt],
  );
  return id;
}

async function recordUsage(
  pool: Pool,
  accountId: AccountId,
  conversationId: string | null,
  createdAt: string,
  count = 1,
): Promise<void> {
  for (let i = 0; i < count; i++) {
    await pool.query(
      `insert into seer.model_usage
         (account_id, conversation_id, tier, model, latency_ms, created_at)
       values ($1, $2, 'fast', 'test-model', 1, $3::timestamptz)`,
      [accountId, conversationId, createdAt],
    );
  }
}

assert.equal(READ_TICK_ACCOUNT_LIMIT, 200);

const db = await startTestDb();
try {
  const userId = await upsertUser("read-queue@example.com");
  const huge = await upsertAccount({
    userId,
    provider: "microsoft",
    email: "huge-backlog@example.com",
  });
  const quiet = await upsertAccount({
    userId,
    provider: "google",
    email: "quiet-desk@example.com",
  });
  const mid = await upsertAccount({
    userId,
    provider: "microsoft",
    email: "mid-desk@example.com",
  });

  await addInbox(db.pool, huge, "huge-1", "2026-08-31T01:00:00Z");
  await addInbox(db.pool, mid, "mid-1", "2026-08-31T01:00:00Z");
  const quietConvo = await addInbox(
    db.pool,
    quiet,
    "quiet-1",
    "2026-08-31T01:00:00Z",
  );

  await recordUsage(db.pool, huge, null, "2026-08-31T01:20:00Z");
  await recordUsage(db.pool, mid, null, "2026-08-31T01:05:00Z");

  const ordered = await listAccountsForRead();
  assert.deepEqual(
    ordered.map((a) => a.email),
    [
      "quiet-desk@example.com",
      "mid-desk@example.com",
      "huge-backlog@example.com",
    ],
    "the mailbox with no recent model call must be read first",
  );

  const seen: string[] = [];
  const report = await runReadTick({
    deadlineMs: Date.now() + 60_000,
    accounts: ordered,
    perAccountLimit: 8,
    concurrency: 1,
    model: async (input) => {
      seen.push(input.accountId);
      return archive;
    },
  });
  assert.equal(report.length, 3);
  assert.equal(
    report.find((row) => row.email === "quiet-desk@example.com")?.decided,
    1,
  );
  assert.ok(seen.includes(quiet), "the quiet desk must get a pipe this tick");
  assert.equal(seen.length, 3, "every mailbox is read in parallel, not queued");
  const afterFirst = await db.pool.query<{ home: string }>(
    `select home from seer.conversation_decisions
      where conversation_id = $1 and is_current`,
    [quietConvo],
  );
  assert.equal(afterFirst.rows[0]?.home, "record");
  assert.equal(
    (await conversationsNeedingRead(quiet)).length,
    0,
    "the starved desk's mail must actually be classified on this tick",
  );

  // A paid attempt that never produced a decision backs off.
  const poison = await addInbox(
    db.pool,
    quiet,
    "poison-titan",
    "2026-07-31T15:00:00Z",
  );
  await saveDecision({
    accountId: quiet,
    conversationId: asConversationId(poison),
    home: "undecided",
    proposedHome: "undecided",
    summary: "",
    rationale: "Not read yet — model unavailable",
    owner: "nobody",
    vetoReasons: ["read_failed"],
    yields: [],
    evidence: [],
    modelVersion: "v2-read-2-router",
    contextVersion: "v2-ctx-1",
  });
  await db.pool.query(
    `update seer.conversation_decisions
        set decided_at = now() - interval '8 days'
      where conversation_id = $1 and is_current`,
    [poison],
  );
  await recordUsage(
    db.pool,
    quiet,
    poison,
    new Date(Date.now() - 60 * 60 * 1000).toISOString(),
    12,
  );
  const backedOff = await conversationsNeedingRead(quiet);
  assert.ok(
    !backedOff.some((id) => String(id) === poison),
    "a poison-pill thread with many recent paid attempts must not be retried this tick",
  );

  // An old-version SUCCESS is still re-read (prompt/schema change).
  const staleOk = await addInbox(
    db.pool,
    quiet,
    "stale-success",
    "2026-08-30T12:00:00Z",
  );
  await saveDecision({
    accountId: quiet,
    conversationId: asConversationId(staleOk),
    home: "record",
    proposedHome: "record",
    summary: "Old successful read",
    rationale: "old",
    owner: "nobody",
    vetoReasons: [],
    yields: [],
    evidence: [],
    modelVersion: "old-model",
    contextVersion: "old-context",
  });
  const refresh = await conversationsNeedingRead(quiet);
  assert.ok(
    refresh.some((id) => String(id) === staleOk),
    "successful classifications from an older model must still refresh",
  );
  assert.ok(
    !refresh.some((id) => String(id) === poison),
    "refreshing the prompt must not bypass backoff on a failed read",
  );

  // A brand-new conversation with no model_usage is eligible immediately.
  const fresh = await addInbox(
    db.pool,
    quiet,
    "fresh-mail",
    "2026-08-31T01:30:00Z",
  );
  const withFresh = await conversationsNeedingRead(quiet);
  assert.ok(
    withFresh.some((id) => String(id) === fresh),
    "mail that has never been attempted stays at the front of the queue",
  );

  const slowId = await upsertAccount({
    userId,
    provider: "google",
    email: "slow-pipe@example.com",
  });
  const fastId = await upsertAccount({
    userId,
    provider: "google",
    email: "fast-pipe@example.com",
  });
  await addInbox(db.pool, slowId, "slow-1", "2026-08-31T02:00:00Z");
  await addInbox(db.pool, fastId, "fast-1", "2026-08-31T02:00:00Z");
  const pipes = (await listAccountsForRead()).filter(
    (account) => account.email.endsWith("-pipe@example.com"),
  );
  const isolated = await runReadTick({
    deadlineMs: Date.now() + 400,
    accounts: pipes.sort((a, b) => a.email.localeCompare(b.email)).reverse(),
    perAccountLimit: 8,
    concurrency: 1,
    model: async (input) => {
      if (input.accountId === slowId) {
        await new Promise((resolve) => setTimeout(resolve, 800));
      }
      return archive;
    },
  });
  assert.equal(
    isolated.find((row) => row.email === "fast-pipe@example.com")?.decided,
    1,
    "a slow inbox must not block a sibling mailbox's pipe",
  );

  // Supplementary context tables must not take the whole desk down.
  await db.pool.query("drop table seer.operating_models");
  await db.pool.query("drop table seer.mailbox_styles");
  const context = await loadContextInput(quiet, "quiet-desk@example.com");
  assert.equal(context.operatingGuidance, "");
  assert.equal(context.mailboxStyleGuidance, "");
  assert.equal(context.ownEmail, "quiet-desk@example.com");

  const recovered = await runReadTick({
    deadlineMs: Date.now() + 60_000,
    accounts: ordered.filter((a) => a.email === "quiet-desk@example.com"),
    perAccountLimit: 8,
    concurrency: 1,
    model: async () => archive,
  });
  assert.equal(
    recovered[0]?.error,
    undefined,
    "a missing operating-model table must not fail the read tick",
  );
  assert.ok(
    (recovered[0]?.decided ?? 0) >= 1,
    "reads continue without optional context tables",
  );

  console.log("v2-read-queue: OK");
} finally {
  await db.stop();
}
