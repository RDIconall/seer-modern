/**
 * Task 6 gate: provider search pagination with brain metadata join and
 * transient rows for not-yet-synced provider results.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { startTestDb } from "./v2-testdb.mts";
import { upsertUser, upsertAccount } from "../src/lib/v2/db/accounts.ts";
import { saveDecision } from "../src/lib/v2/intelligence/repository.ts";
import { searchWithMetadata } from "../src/lib/v3/search/repository.ts";
import { FakeProvider } from "../src/lib/v2/providers/fake.ts";
import { asConversationId, type AccountId } from "../src/lib/v2/db/types.ts";
import type { Message } from "../src/lib/v2/providers/types.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));

function msg(id: string, body: string): Message & { folder: "inbox" } {
  return {
    providerMessageId: id,
    from: { email: "s@x.com" },
    to: [{ email: "me@x.com" }],
    cc: [],
    sentAt: "2026-08-10T10:00:00Z",
    snippet: body,
    bodyHtml: `<p>${body}</p>`,
    bodyText: body,
    isUnread: false,
    isOutgoing: false,
    attachments: [],
    folder: "inbox",
  } as Message & { folder: "inbox" };
}

async function seedCorpus(
  pool: import("pg").Pool,
  accountId: AccountId,
  providerId: string,
  subject: string,
) {
  const c = await pool.query<{ id: string }>(
    `insert into seer.conversations
       (account_id, provider_conversation_id, subject, last_message_at, folders, is_unread)
     values ($1, $2, $3, now(), array['inbox']::text[], false)
     returning id`,
    [accountId, providerId, subject],
  );
  await pool.query(
    `insert into seer.messages
       (account_id, conversation_id, provider_message_id, from_email, to_emails, sent_at, snippet, is_unread, is_outgoing)
     values ($1, $2, $3, 's@x.com', array['me@x.com'], now(), 'x', false, false)`,
    [accountId, c.rows[0].id, `${providerId}-m1`],
  );
  return asConversationId(c.rows[0].id);
}

const db = await startTestDb();
try {
  const userId = await upsertUser("search@example.com");
  const accountId = await upsertAccount({
    userId,
    provider: "google",
    email: "search@example.com",
  });

  const syncedId = await seedCorpus(db.pool, accountId, "p-synced", "Alpha negotiation");
  const matter = await db.pool.query<{ id: string }>(
    "insert into seer.matters (account_id, title, org_unit) values ($1, 'Deal Alpha', 'sales') returning id",
    [accountId],
  );
  await saveDecision({
    accountId,
    conversationId: syncedId,
    home: "matter",
    proposedHome: "matter",
    summary: "Active negotiation",
    rationale: "priority",
    owner: "you",
    matterId: matter.rows[0].id,
    vetoReasons: [],
    yields: [],
    evidence: [],
    priority: 90,
    dueDate: "2026-08-20",
  });

  const provider = new FakeProvider({
    pageSize: 1,
    conversations: [
      { providerConversationId: "p-synced", subject: "Alpha negotiation", messages: [msg("m1", "alpha terms")] },
      { providerConversationId: "p-fresh", subject: "Brand new thread", messages: [msg("m2", "alpha inquiry")] },
      { providerConversationId: "p-other", subject: "Unrelated", messages: [msg("m3", "weekly report")] },
    ],
  });

  const page1 = await searchWithMetadata(accountId, provider, "alpha", null);
  assert.equal(page1.rows.length, 1);
  assert.ok(page1.nextCursor, "search must paginate");
  assert.equal(page1.rows[0].providerConversationId, "p-synced");
  assert.equal(page1.rows[0].synced, true);
  assert.equal(page1.rows[0].conversationId, syncedId);
  assert.equal(page1.rows[0].decisionSummary, "Active negotiation");
  assert.equal(page1.rows[0].matterTitle, "Deal Alpha");
  assert.equal(page1.rows[0].priority, 90);
  assert.equal(page1.rows[0].dueDate, "2026-08-20");
  assert.equal(page1.rows[0].transient, false);

  const page2 = await searchWithMetadata(accountId, provider, "alpha", page1.nextCursor);
  assert.equal(page2.rows.length, 1);
  assert.equal(page2.rows[0].providerConversationId, "p-fresh");
  assert.equal(page2.rows[0].synced, false);
  assert.equal(page2.rows[0].transient, true);
  assert.equal(page2.rows[0].conversationId, undefined);
  assert.equal(page2.rows[0].decisionSummary, null);
  assert.equal(page2.nextCursor, null, "only two alpha matches across pages");

  const searchRoute = readFileSync(path.join(HERE, "../src/app/api/v3/search/route.ts"), "utf8");
  assert.match(searchRoute, /getActiveV2Account/);
  assert.match(searchRoute, /searchWithMetadata/);
  assert.match(searchRoute, /providerFor/);
  assert.ok(!/accessToken|refreshToken|ciphertext/i.test(searchRoute));

  console.log("v3-search: OK");
} finally {
  await db.stop();
}
