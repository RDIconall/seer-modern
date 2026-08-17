/**
 * sync_runs telemetry must never fail committed page/cursor writes on old schema.
 */
import assert from "node:assert/strict";
import { startTestDb } from "./v2-testdb.mts";
import { upsertUser, upsertAccount } from "../src/lib/v2/db/accounts.ts";
import { FakeProvider } from "../src/lib/v2/providers/fake.ts";
import { syncFolder } from "../src/lib/v2/sync/engine.ts";
import type { Message } from "../src/lib/v2/providers/types.ts";

function msg(id: string): Message & { folder: "inbox" } {
  return {
    providerMessageId: id,
    from: { email: "s@example.com" },
    to: [{ email: "me@example.com" }],
    cc: [],
    sentAt: "2026-08-01T10:00:00Z",
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
  await db.pool.query(
    `alter table seer.sync_runs drop column if exists folder`,
  );
  await db.pool.query(
    `alter table seer.sync_runs drop column if exists complete`,
  );

  const userId = await upsertUser("runs-compat@example.com");
  const accountId = await upsertAccount({
    userId,
    provider: "google",
    email: "runs-compat@example.com",
  });

  const provider = new FakeProvider({
    pageSize: 10,
    conversations: [
      {
        providerConversationId: "c1",
        subject: "One",
        messages: [msg("c1-m1")],
      },
    ],
  });

  const run = await syncFolder(accountId, provider, "inbox", "incremental");
  assert.equal(run.pages, 1);
  assert.equal(run.complete, true);
  assert.equal(run.telemetryWarning, undefined, "legacy sync_runs insert must succeed");

  const runs = await db.pool.query<{ n: number }>(
    "select count(*)::int as n from seer.sync_runs where account_id = $1",
    [accountId],
  );
  assert.equal(runs.rows[0].n, 1);

  const cursor = await db.pool.query<{ backfill_complete: boolean }>(
    `select backfill_complete from seer.folder_sync_state
      where account_id = $1 and folder = 'inbox'`,
    [accountId],
  );
  assert.equal(cursor.rows[0].backfill_complete, true, "cursor write must commit despite old sync_runs schema");

  console.log("v3-sync-runs-compat: OK");
} finally {
  await db.stop();
}
