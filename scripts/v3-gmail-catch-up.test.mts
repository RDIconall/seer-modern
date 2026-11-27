/**
 * Login catch-up on Gmail must poll the newest mail, not resume a stuck
 * historical scan. A mailbox whose backfill never finished kept walking old
 * pages on sign-in, so Gmail looked frozen even after the login refresh.
 */
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import { startTestDb } from "./v2-testdb.mts";
import { upsertUser, upsertAccount } from "../src/lib/v2/db/accounts.ts";
import { FakeProvider } from "../src/lib/v2/providers/fake.ts";
import { syncFolder } from "../src/lib/v2/sync/engine.ts";
import { inboxNeedsCatchUp } from "../src/lib/v2/sync/catch-up.ts";
import type { Message } from "../src/lib/v2/providers/types.ts";

function msg(
  id: string,
  sentAt: string,
): Message & { folder: "inbox" } {
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
  const userId = await upsertUser("gmail-catchup@example.com");
  const accountId = await upsertAccount({
    userId,
    provider: "google",
    email: "gmail-catchup@example.com",
  });

  const conversations = Array.from({ length: 12 }, (_, i) => ({
    providerConversationId: `old-${i}`,
    subject: `Old ${i}`,
    messages: [msg(`old-${i}-m`, "2026-08-01T10:00:00Z")],
  }));
  const provider = new FakeProvider({ pageSize: 5, conversations });

  const partial = await syncFolder(accountId, provider, "inbox", "incremental", {
    maxPages: 1,
  });
  assert.equal(partial.backfillComplete, false);
  assert.equal(partial.polledHead, false);
  const storedAfterPartial = await db.pool.query<{ n: number }>(
    "select count(*)::int as n from seer.conversations where account_id = $1",
    [accountId],
  );
  assert.equal(storedAfterPartial.rows[0].n, 5);

  await db.pool.query(
    `update seer.conversations
        set last_synced_at = now()
      where account_id = $1`,
    [accountId],
  );
  assert.equal(
    await inboxNeedsCatchUp(accountId),
    true,
    "an unfinished Gmail backfill must still catch up on login",
  );

  conversations.unshift({
    providerConversationId: "fresh-1",
    subject: "Arrived while you were away",
    messages: [msg("fresh-1-m", "2026-09-20T02:00:00Z")],
  });

  const resumed = await syncFolder(accountId, provider, "inbox", "incremental", {
    maxPages: 1,
  });
  assert.equal(resumed.polledHead, false);
  const afterResume = await db.pool.query<{ ids: string[] }>(
    `select coalesce(array_agg(provider_conversation_id), '{}') as ids
       from seer.conversations where account_id = $1`,
    [accountId],
  );
  assert.equal(
    afterResume.rows[0].ids.includes("fresh-1"),
    false,
    "resuming the scan must not be how login finds new Gmail",
  );

  const catchUp = await syncFolder(accountId, provider, "inbox", "incremental", {
    maxPages: 1,
    headOnly: true,
    pageSize: 3,
  });
  assert.equal(catchUp.polledHead, true);
  assert.equal(
    catchUp.backfillComplete,
    false,
    "a login head poll must not pretend the historical scan finished",
  );
  const afterCatchUp = await db.pool.query<{
    ids: string[];
    complete: boolean;
    cursor: string | null;
    reconciled: Date | string | null;
  }>(
    `select
       (select coalesce(array_agg(provider_conversation_id), '{}')
          from seer.conversations where account_id = $1) as ids,
       s.backfill_complete as complete,
       s.cursor,
       s.last_reconciled_at as reconciled
       from seer.folder_sync_state s
      where s.account_id = $1 and s.folder = 'inbox'`,
    [accountId],
  );
  assert.equal(afterCatchUp.rows[0].ids.includes("fresh-1"), true);
  assert.equal(afterCatchUp.rows[0].complete, false);
  assert.notEqual(afterCatchUp.rows[0].cursor, null);
  assert.equal(
    afterCatchUp.rows[0].reconciled != null,
    true,
    "a successful Gmail head poll must stamp last_reconciled_at so login stops re-kicking",
  );
  assert.equal(
    await inboxNeedsCatchUp(accountId),
    false,
    "an unfinished backfill that just head-polled must not stampede Gmail on every refresh",
  );

  const catchUpSource = await fs.readFile(
    path.join(process.cwd(), "src/lib/v2/sync/catch-up.ts"),
    "utf8",
  );
  assert.match(catchUpSource, /headOnly:\s*true/);
  assert.match(catchUpSource, /GMAIL_CATCH_UP_PAGE_SIZE|pageSize: 1[0-9]/);
  assert.doesNotMatch(
    catchUpSource,
    /claimWorkerLease/,
    "a stuck Gmail cron lease must not block the login head poll",
  );
  assert.match(catchUpSource, /inboxNeedsCatchUp|!.*backfillComplete/);
  assert.match(
    catchUpSource,
    /lastReconciledAt/,
    "stuck Gmail backfill freshness is the last head poll, not 'backfill still running'",
  );

  for (const route of [
    "src/app/api/v3/mailbox/route.ts",
    "src/app/api/v2/inbox/route.ts",
  ]) {
    const source = await fs.readFile(path.join(process.cwd(), route), "utf8");
    assert.match(
      source,
      /after\(\s*work\s*\)/,
      `${route} must keep the function alive until Gmail catch-up finishes`,
    );
    assert.doesNotMatch(
      source,
      /void work\(\)/,
      `${route} must not fire-and-forget catch-up — Vercel kills that promise`,
    );
    assert.match(
      source,
      /export const maxDuration = [3-9][0-9]/,
      `${route} must outlive a Gmail head poll, not the default 10–15s function window`,
    );
  }
} finally {
  await db.stop();
}

console.log("v3-gmail-catch-up: OK");
