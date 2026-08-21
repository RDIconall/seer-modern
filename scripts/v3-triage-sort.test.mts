/**
 * Inbox SMART SORT: triage ordering, keyset cursors, and the delete-token
 * safety boundary on mailbox rows.
 */
import assert from "node:assert/strict";
import { startTestDb } from "./v2-testdb.mts";
import { upsertUser, upsertAccount } from "../src/lib/v2/db/accounts.ts";
import { saveDecision } from "../src/lib/v2/intelligence/repository.ts";
import { asConversationId, type AccountId } from "../src/lib/v2/db/types.ts";
import {
  decodeMailboxCursor,
  encodeMailboxCursor,
} from "../src/lib/v3/mailbox/cursor.ts";
import { getMailboxView } from "../src/lib/v3/mailbox/repository.ts";
import {
  TRIAGE_ORDER,
  deleteRank,
  dispositionFromHome,
} from "../src/lib/v3/mailbox/triage-rank.ts";

async function seedConversation(
  pool: import("pg").Pool,
  accountId: AccountId,
  providerId: string,
  folder: "inbox" | "sent" | "trash",
  subject: string,
  sentAt: string,
  opts: {
    outgoing?: boolean;
    unread?: boolean;
    snippet?: string;
    attachments?: string[];
    functionName?: string | null;
  } = {},
) {
  const c = await pool.query<{ id: string }>(
    `insert into seer.conversations
       (account_id, provider_conversation_id, subject, last_message_at, folders, is_unread, function_name)
     values ($1, $2, $3, $4, array[$5]::text[], $6, $7)
     returning id`,
    [
      accountId,
      providerId,
      subject,
      sentAt,
      folder,
      opts.unread ?? false,
      opts.functionName ?? null,
    ],
  );
  await pool.query(
    `insert into seer.messages
       (account_id, conversation_id, provider_message_id, from_email, from_name,
        to_emails, sent_at, snippet, is_unread, is_outgoing, attachment_names)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
    [
      accountId,
      c.rows[0].id,
      `${providerId}-m1`,
      opts.outgoing ? "me@example.com" : "alice@example.com",
      opts.outgoing ? "Me" : "Alice",
      [opts.outgoing ? "bob@example.com" : "me@example.com"],
      sentAt,
      opts.snippet ?? "hello",
      opts.unread ?? false,
      opts.outgoing ?? false,
      opts.attachments ?? [],
    ],
  );
  return asConversationId(c.rows[0].id);
}

const HOMES = ["delete", "record", "undecided", "matter", null] as const;

// --- 1. Pure ranking -------------------------------------------------------
assert.equal(TRIAGE_ORDER[0], "delete");
assert.equal(TRIAGE_ORDER[TRIAGE_ORDER.length - 1], "pending");
for (const home of ["delete", "record", "undecided", "matter", null, "garbage"] as const) {
  const disposition = dispositionFromHome(home);
  assert.equal(
    deleteRank(disposition),
    TRIAGE_ORDER.indexOf(disposition),
    `rank for home=${home}`,
  );
}
assert.equal(deleteRank(dispositionFromHome("delete")), 0);
assert.equal(deleteRank(dispositionFromHome(null)), 4);

// --- 2. Cursor round-trip --------------------------------------------------
const triageCursor = encodeMailboxCursor({
  sort: "triage",
  rank: 0,
  priority: 2,
  at: "2026-08-01T00:00:00.000Z",
  id: "11111111-1111-1111-1111-111111111111",
});
assert.deepEqual(decodeMailboxCursor(triageCursor, "triage"), {
  sort: "triage",
  rank: 0,
  priority: 2,
  at: "2026-08-01T00:00:00.000Z",
  id: "11111111-1111-1111-1111-111111111111",
});
assert.equal(decodeMailboxCursor(triageCursor, "date"), null);

const dateCursor = encodeMailboxCursor({
  sort: "date",
  at: "2026-08-01T00:00:00.000Z",
  id: "11111111-1111-1111-1111-111111111111",
});
assert.deepEqual(decodeMailboxCursor(dateCursor, "date"), {
  sort: "date",
  at: "2026-08-01T00:00:00.000Z",
  id: "11111111-1111-1111-1111-111111111111",
});
assert.equal(decodeMailboxCursor(dateCursor, "triage"), null);

const legacyCursor = Buffer.from(
  JSON.stringify({
    at: "2026-08-01T00:00:00.000Z",
    id: "11111111-1111-1111-1111-111111111111",
  }),
).toString("base64url");
assert.deepEqual(decodeMailboxCursor(legacyCursor, "date"), {
  sort: "date",
  at: "2026-08-01T00:00:00.000Z",
  id: "11111111-1111-1111-1111-111111111111",
});
assert.equal(decodeMailboxCursor(legacyCursor, "triage"), null);

const db = await startTestDb();
try {
  const userId = await upsertUser("triage-sort@example.com");
  const accountId = await upsertAccount({
    userId,
    provider: "google",
    email: "triage-sort@example.com",
  });

  const matter = await db.pool.query<{ id: string }>(
    "insert into seer.matters (account_id, title, org_unit) values ($1, 'Live Deal', 'sales') returning id",
    [accountId],
  );
  const matterId = matter.rows[0].id;

  // Timestamps deliberately contradict TRIAGE_ORDER: delete is oldest, pending newest.
  const seeded: { home: (typeof HOMES)[number]; id: string; subject: string }[] = [];
  const stamps: Record<string, string> = {
    delete: "2026-08-01T12:00:00Z",
    record: "2026-08-02T12:00:00Z",
    undecided: "2026-08-03T12:00:00Z",
    matter: "2026-08-04T12:00:00Z",
    pending: "2026-08-05T12:00:00Z",
  };

  for (const home of HOMES) {
    const label = home ?? "pending";
    const id = await seedConversation(
      db.pool,
      accountId,
      `p-${label}`,
      "inbox",
      `Row ${label}`,
      stamps[label],
      { functionName: home === "matter" ? "sales" : home === "delete" ? "ops" : null },
    );
    if (home) {
      await saveDecision({
        accountId,
        conversationId: id,
        home,
        proposedHome: home === "undecided" ? "delete" : home,
        summary: `${label} summary`,
        rationale: "test",
        owner: "you",
        matterId: home === "matter" ? matterId : null,
        vetoReasons: home === "undecided" ? ["needs review"] : [],
        yields: [],
        evidence: [],
        priority: 50,
      });
    }
    seeded.push({ home, id, subject: `Row ${label}` });
  }

  // --- 3. DB ordering ------------------------------------------------------
  const triage = await getMailboxView(accountId, "inbox", 20, undefined, "triage");
  assert.equal(triage.sort, "triage");
  assert.equal(triage.total, 4, "Atlas matters are not duplicated in Triage");
  assert.deepEqual(
    triage.rows.map((r) => r.disposition),
    TRIAGE_ORDER.filter((disposition) => disposition !== "matter"),
  );
  assert.deepEqual(
    triage.rows.map((r) => r.deleteRank),
    [0, 1, 2, 4],
  );
  assert.equal(triage.rows[0].subject, "Row delete");
  assert.equal(triage.rows[3].subject, "Row pending");
  assert.equal(triage.rows[0].category, "ops");
  assert.equal(triage.rows[3].category, null);
  assert.ok(!triage.rows.some((row) => row.category === "sales"));

  for (const row of triage.rows) {
    assert.equal(row.deleteRank, deleteRank(row.disposition));
  }

  const byDate = await getMailboxView(accountId, "inbox", 20, undefined, "date");
  assert.equal(byDate.sort, "date");
  assert.equal(byDate.rows[0].subject, "Row pending");
  assert.equal(byDate.rows[byDate.rows.length - 1].subject, "Row delete");

  // --- 5. Safety: deleteToken only on delete, both sorts -------------------
  for (const view of [triage, byDate]) {
    for (const row of view.rows) {
      if (row.disposition === "delete") {
        assert.equal(typeof row.deleteToken, "string");
        assert.ok(row.deleteToken && row.deleteToken.length > 0);
      } else {
        assert.equal(
          row.deleteToken,
          null,
          `deleteToken must be null for disposition=${row.disposition} sort=${view.sort}`,
        );
      }
    }
  }

  // --- 4. Within-rank ordering ---------------------------------------------
  const rankUserId = await upsertUser("triage-rank@example.com");
  const rankAccountId = await upsertAccount({
    userId: rankUserId,
    provider: "google",
    email: "triage-rank@example.com",
  });

  const hiPri = await seedConversation(
    db.pool,
    rankAccountId,
    "p-hi",
    "inbox",
    "High priority delete",
    "2026-08-10T12:00:00Z",
  );
  const loPri = await seedConversation(
    db.pool,
    rankAccountId,
    "p-lo",
    "inbox",
    "Low priority delete",
    "2026-08-11T12:00:00Z",
  );
  await saveDecision({
    accountId: rankAccountId,
    conversationId: hiPri,
    home: "delete",
    proposedHome: "delete",
    summary: "hi",
    rationale: "test",
    owner: "you",
    vetoReasons: [],
    yields: [],
    evidence: [],
    priority: 90,
  });
  await saveDecision({
    accountId: rankAccountId,
    conversationId: loPri,
    home: "delete",
    proposedHome: "delete",
    summary: "lo",
    rationale: "test",
    owner: "you",
    vetoReasons: [],
    yields: [],
    evidence: [],
    priority: 10,
  });

  const byPriority = await getMailboxView(rankAccountId, "inbox", 10, undefined, "triage");
  assert.equal(byPriority.rows[0].subject, "Low priority delete");
  assert.equal(byPriority.rows[1].subject, "High priority delete");

  const tieUserId = await upsertUser("triage-tie@example.com");
  const tieAccountId = await upsertAccount({
    userId: tieUserId,
    provider: "google",
    email: "triage-tie@example.com",
  });
  const newer = await seedConversation(
    db.pool,
    tieAccountId,
    "p-newer",
    "inbox",
    "Newer equal priority",
    "2026-08-12T12:00:00Z",
  );
  const older = await seedConversation(
    db.pool,
    tieAccountId,
    "p-older",
    "inbox",
    "Older equal priority",
    "2026-08-09T12:00:00Z",
  );
  for (const id of [newer, older]) {
    await saveDecision({
      accountId: tieAccountId,
      conversationId: id,
      home: "delete",
      proposedHome: "delete",
      summary: "tie",
      rationale: "test",
      owner: "you",
      vetoReasons: [],
      yields: [],
      evidence: [],
      priority: 40,
    });
  }
  const byAge = await getMailboxView(tieAccountId, "inbox", 10, undefined, "triage");
  assert.equal(byAge.rows[0].subject, "Older equal priority");
  assert.equal(byAge.rows[1].subject, "Newer equal priority");

  // --- 6. Pagination: one row at a time, no skips/dupes --------------------
  const full = await getMailboxView(accountId, "inbox", 50, undefined, "triage");
  const seen: string[] = [];
  let cursor: string | undefined;
  for (let pageNum = 0; pageNum < 20; pageNum++) {
    const page = await getMailboxView(accountId, "inbox", 1, cursor, "triage");
    if (page.rows.length === 0) break;
    seen.push(page.rows[0].conversationId);
    cursor = page.nextCursor ?? undefined;
    if (!cursor) break;
  }
  assert.deepEqual(
    seen,
    full.rows.map((r) => r.conversationId),
    "paginated triage sequence must match unpaginated",
  );
  assert.equal(new Set(seen).size, seen.length, "no duplicate conversation across pages");

  // --- 7. Cross-sort cursor refused → starts from top ----------------------
  const datePage = await getMailboxView(accountId, "inbox", 1, undefined, "date");
  assert.ok(datePage.nextCursor);
  const triageWithDateCursor = await getMailboxView(
    accountId,
    "inbox",
    1,
    datePage.nextCursor!,
    "triage",
  );
  assert.equal(
    triageWithDateCursor.rows[0].conversationId,
    full.rows[0].conversationId,
    "date cursor on triage request must restart from the top",
  );

  const triagePage = await getMailboxView(accountId, "inbox", 1, undefined, "triage");
  assert.ok(triagePage.nextCursor);
  const dateWithTriageCursor = await getMailboxView(
    accountId,
    "inbox",
    1,
    triagePage.nextCursor!,
    "date",
  );
  assert.equal(
    dateWithTriageCursor.rows[0].conversationId,
    byDate.rows[0].conversationId,
    "triage cursor on date request must restart from the top",
  );

  console.log("v3-triage-sort: OK");
} finally {
  await db.stop();
}
