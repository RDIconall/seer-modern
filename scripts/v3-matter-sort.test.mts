/**
 * The Inbox's matter sort: conversations on one matter sit together, groups run
 * oldest-first by their oldest conversation, the cursor pages over groups
 * without reshuffling them, and each row says what should happen next.
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
import { nextStepFor } from "../src/lib/v3/mailbox/next-step.ts";

async function seedConversation(
  pool: import("pg").Pool,
  accountId: AccountId,
  providerId: string,
  subject: string,
  sentAt: string,
) {
  const c = await pool.query<{ id: string }>(
    `insert into seer.conversations
       (account_id, provider_conversation_id, subject, last_message_at, folders, is_unread)
     values ($1, $2, $3, $4, array['inbox']::text[], false)
     returning id`,
    [accountId, providerId, subject, sentAt],
  );
  await pool.query(
    `insert into seer.messages
       (account_id, conversation_id, provider_message_id, from_email, from_name,
        to_emails, sent_at, snippet, is_unread, is_outgoing, attachment_names)
     values ($1, $2, $3, 'alice@example.com', 'Alice', array['me@example.com'], $4,
             'hello', false, false, '{}')`,
    [accountId, c.rows[0].id, `${providerId}-m1`, sentAt],
  );
  return asConversationId(c.rows[0].id);
}

// --- 1. Pure next-step wording ----------------------------------------------
{
  const onMatter = nextStepFor({
    disposition: "matter",
    matterId: "m1",
    ask: "Send the redlines",
    summary: "Contract thread",
    userStep: null,
  });
  assert.deepEqual(onMatter, { verb: null, text: "Send the redlines", source: "seer" });

  const edited = nextStepFor({
    disposition: "matter",
    matterId: "m1",
    ask: "Send the redlines",
    summary: "",
    userStep: "  Call Roche first  ",
  });
  assert.equal(edited.text, "Call Roche first", "the person's wording beats Seer's");
  assert.equal(edited.source, "user");

  const informational = nextStepFor({
    disposition: "matter",
    matterId: "m1",
    ask: "nothing — informational",
    summary: "",
    userStep: null,
  });
  assert.equal(informational.source, "default");
  assert.equal(informational.text, "Review the latest conversation");

  assert.equal(
    nextStepFor({ disposition: "delete", matterId: null, ask: null, summary: "Digest", userStep: null }).verb,
    "delete",
  );
  assert.equal(
    nextStepFor({ disposition: "record", matterId: null, ask: null, summary: null, userStep: null }).verb,
    "record",
  );
  for (const disposition of ["undecided", "pending"] as const) {
    assert.equal(
      nextStepFor({ disposition, matterId: null, ask: null, summary: null, userStep: null }).verb,
      "archive",
      `${disposition} falls back to the reversible verb`,
    );
  }
  const long = nextStepFor({
    disposition: "matter",
    matterId: "m1",
    ask: "x".repeat(400),
    summary: "",
    userStep: null,
  });
  assert.ok(long.text.length <= 140, "a long ask is clipped for the column");
}

// --- 2. Cursor ---------------------------------------------------------------
{
  const cursor = {
    sort: "matter" as const,
    groupAt: "2026-08-01T00:00:00.000Z",
    groupKey: "m:abc",
    at: "2026-08-02T00:00:00.000Z",
    id: "11111111-1111-1111-1111-111111111111",
  };
  const encoded = encodeMailboxCursor(cursor);
  assert.deepEqual(decodeMailboxCursor(encoded, "matter"), cursor);
  assert.equal(decodeMailboxCursor(encoded, "date"), null, "a matter cursor is not a date cursor");
  const dateCursor = encodeMailboxCursor({
    sort: "date",
    at: "2026-08-01T00:00:00.000Z",
    id: "11111111-1111-1111-1111-111111111111",
  });
  assert.equal(decodeMailboxCursor(dateCursor, "matter"), null);
}

// --- 3. Database ordering and paging ----------------------------------------
const db = await startTestDb();
try {
  const userId = await upsertUser("matter-sort@example.com");
  const accountId = await upsertAccount({
    userId,
    provider: "google",
    email: "matter-sort@example.com",
  });

  const matterRow = async (title: string, userStep: string | null = null) => {
    const m = await db.pool.query<{ id: string }>(
      "insert into seer.matters (account_id, title, next_step_user) values ($1, $2, $3) returning id",
      [accountId, title, userStep],
    );
    return m.rows[0].id;
  };
  const decide = async (
    id: ReturnType<typeof asConversationId>,
    home: "matter" | "delete" | "record" | "undecided",
    extra: { matterId?: string | null; ask?: string | null; summary?: string } = {},
  ) =>
    saveDecision({
      accountId,
      conversationId: id,
      home,
      proposedHome: home,
      summary: extra.summary ?? `${home} summary`,
      rationale: "test",
      owner: "you",
      ask: extra.ask ?? undefined,
      matterId: extra.matterId ?? null,
      vetoReasons: [],
      yields: [],
      evidence: [],
      priority: 0,
    });

  const roche = await matterRow("Roche contract");
  const quality = await matterRow("Deviation DV-0412", "Sign the CAPA form");

  // Roche's oldest email is the oldest in the inbox; a lone digest sits between
  // its newer emails, so only grouping by matter can keep them together.
  const r1 = await seedConversation(db.pool, accountId, "p-roche-1", "Roche v1", "2026-08-01T10:00:00Z");
  const digest = await seedConversation(db.pool, accountId, "p-digest", "Weekly digest", "2026-08-05T10:00:00Z");
  const r2 = await seedConversation(db.pool, accountId, "p-roche-2", "Roche v2", "2026-08-09T10:00:00Z");
  const q1 = await seedConversation(db.pool, accountId, "p-q-1", "DV-0412 opened", "2026-08-03T10:00:00Z");
  const q2 = await seedConversation(db.pool, accountId, "p-q-2", "DV-0412 CAPA", "2026-08-10T10:00:00Z");
  const receipt = await seedConversation(db.pool, accountId, "p-receipt", "Invoice paid", "2026-08-07T10:00:00Z");
  const unread = await seedConversation(db.pool, accountId, "p-new", "Not read yet", "2026-08-11T10:00:00Z");

  await decide(r1, "matter", { matterId: roche, ask: "Send redlines to Roche legal" });
  await decide(r2, "matter", { matterId: roche, ask: "Send redlines to Roche legal" });
  await decide(q1, "matter", { matterId: quality, ask: "Approve CAPA plan" });
  await decide(q2, "matter", { matterId: quality, ask: "Approve CAPA plan" });
  await decide(digest, "delete", { summary: "Promotional digest" });
  await decide(receipt, "record", { summary: "Paid invoice" });
  void unread;

  const view = await getMailboxView(accountId, "inbox", 50, undefined, "matter");
  assert.equal(view.sort, "matter");
  assert.equal(view.total, 7);
  assert.equal(view.groups, 5, "two matters + three standalone conversations");
  assert.deepEqual(
    view.rows.map((r) => r.subject),
    [
      "Roche v2", // group 1: Roche (oldest email Aug 1), newest first inside
      "Roche v1",
      "DV-0412 CAPA", // group 2: quality (oldest email Aug 3)
      "DV-0412 opened",
      "Weekly digest", // Aug 5
      "Invoice paid", // Aug 7
      "Not read yet", // Aug 11
    ],
    "groups run oldest first and a matter's emails stay together",
  );

  const [rocheNewest, , qualityNewest] = view.rows;
  assert.equal(rocheNewest.matterId, roche);
  assert.equal(rocheNewest.groupKey, `m:${roche}`);
  assert.equal(rocheNewest.groupAt, "2026-08-01T10:00:00.000Z", "group age is its oldest email");
  assert.equal(view.rows[1].groupAt, rocheNewest.groupAt);
  assert.deepEqual(rocheNewest.nextStep, {
    verb: null,
    text: "Send redlines to Roche legal",
    source: "seer",
  });
  assert.equal(qualityNewest.nextStep.text, "Sign the CAPA form", "an edited step wins");
  assert.equal(qualityNewest.nextStep.source, "user");

  const digestRow = view.rows[4];
  assert.equal(digestRow.matterId, null);
  assert.equal(digestRow.groupKey, `c:${digest}`);
  assert.equal(digestRow.nextStep.verb, "delete");
  assert.equal(digestRow.nextStep.text, "Promotional digest");
  assert.equal(view.rows[5].nextStep.verb, "record");
  assert.equal(view.rows[6].nextStep.verb, "archive", "unread-by-Seer mail proposes the reversible verb");

  // Paging cuts through a group; the next page continues it in place.
  const seen: string[] = [];
  let cursor: string | undefined;
  let pages = 0;
  do {
    const page = await getMailboxView(accountId, "inbox", 3, cursor, "matter");
    seen.push(...page.rows.map((r) => r.subject));
    cursor = page.nextCursor ?? undefined;
    pages += 1;
  } while (cursor && pages < 10);
  assert.deepEqual(seen, view.rows.map((r) => r.subject), "paged order equals the full order");
  assert.equal(pages, 3);

  // Clearing an old email moves the group's age to its next-oldest email.
  await db.pool.query("update seer.conversations set folders = array['trash']::text[] where id = $1", [r1]);
  const after = await getMailboxView(accountId, "inbox", 50, undefined, "matter");
  assert.equal(after.rows[0].subject, "DV-0412 CAPA", "quality (Aug 3) is now the oldest group");
  const rocheAfter = after.rows.find((r) => r.subject === "Roche v2");
  assert.equal(rocheAfter?.groupAt, "2026-08-09T10:00:00.000Z");

  // Other sorts are untouched.
  const dated = await getMailboxView(accountId, "inbox", 50, undefined, "date");
  assert.equal(dated.groups, undefined);
  assert.equal(dated.rows[0].subject, "Not read yet");
} finally {
  await db.stop();
}

console.log("v3-matter-sort: OK");
