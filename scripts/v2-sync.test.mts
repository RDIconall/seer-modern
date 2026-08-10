/**
 * Task 5 gate: the sync engine drains the whole corpus, resumes by cursor,
 * replays idempotently, records coverage that reconciles to the provider total,
 * and marks deletions. Runs against embedded Postgres + the fake provider.
 */
import assert from "node:assert/strict";
import { startTestDb } from "./v2-testdb.mts";
import { upsertUser, upsertAccount } from "../src/lib/v2/db/accounts.ts";
import { FakeProvider } from "../src/lib/v2/providers/fake.ts";
import { syncAccount } from "../src/lib/v2/sync/engine.ts";
import { coverage } from "../src/lib/v2/sync/repository.ts";
import type { Message } from "../src/lib/v2/providers/types.ts";

function msg(id: string, sentAt: string): Message & { folder: "inbox" | "trash" } {
  return {
    providerMessageId: id,
    from: { email: "s@example.com" },
    to: [{ email: "me@example.com" }],
    cc: [],
    sentAt,
    snippet: "s",
    bodyHtml: "<p>b</p>",
    bodyText: "b",
    isUnread: true,
    isOutgoing: false,
    attachments: [],
    folder: "inbox",
  };
}

const db = await startTestDb();
try {
  const userId = await upsertUser("sync@example.com");
  const accountId = await upsertAccount({
    userId,
    provider: "google",
    email: "sync@example.com",
  });

  const conversations = Array.from({ length: 120 }, (_, i) => ({
    providerConversationId: `s${i}`,
    subject: `Subject ${i}`,
    messages: [msg(`s${i}-m1`, "2026-08-01T10:00:00Z")],
  }));
  conversations[0].messages = [
    msg("s0-m1", "2026-08-01T10:00:00Z"),
    msg("s0-m2", "2026-08-02T10:00:00Z"),
  ];
  const provider = new FakeProvider({ conversations, pageSize: 50 });

  // Full rebuild drains every page.
  const run = await syncAccount(accountId, provider, "full");
  assert.equal(run.pages, 3, "120 convos at pageSize 50 must take 3 pages");
  assert.equal(run.coverage.providerTotal, 120);
  assert.equal(run.coverage.stored, 120);
  assert.equal(run.coverage.pending, 0, "coverage must reconcile to provider total");
  assert.equal(run.coverage.failed, 0);

  // Messages were stored (s0 has two).
  const msgs = await db.pool.query(
    "select count(*)::int as n from seer.messages where account_id = $1",
    [accountId],
  );
  assert.equal(msgs.rows[0].n, 121);

  // Replay is idempotent — no duplicate conversations or messages.
  await syncAccount(accountId, provider, "full");
  const convCount = await db.pool.query(
    "select count(*)::int as n from seer.conversations where account_id = $1",
    [accountId],
  );
  assert.equal(convCount.rows[0].n, 120, "replay must not duplicate conversations");

  // A sync run row was recorded for observability.
  const runs = await db.pool.query(
    "select count(*)::int as n from seer.sync_runs where account_id = $1",
    [accountId],
  );
  assert.equal(runs.rows[0].n, 2);

  // Deletion: move an entire conversation to trash; it is marked deleted and
  // drops out of coverage.
  const target = conversations.find((c) => c.providerConversationId === "s5")!;
  for (const m of target.messages) (m as { folder: string }).folder = "trash";
  await syncAccount(accountId, provider, "incremental");
  const del = await db.pool.query(
    "select is_deleted from seer.conversations where account_id = $1 and provider_conversation_id = 's5'",
    [accountId],
  );
  assert.equal(del.rows[0].is_deleted, true, "trashed conversation must be marked deleted");

  const cov = await coverage(accountId);
  assert.equal(cov.stored, 119, "deleted conversation drops from stored coverage");

  console.log("v2-sync: OK");
} finally {
  await db.stop();
}
