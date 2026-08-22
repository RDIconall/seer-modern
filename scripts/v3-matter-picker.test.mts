/**
 * Gate: long-press matter placement sweeps the real board conservatively.
 */
import assert from "node:assert/strict";
import { startTestDb } from "./v2-testdb.mts";
import { upsertAccount, upsertUser } from "../src/lib/v2/db/accounts.ts";
import { asConversationId } from "../src/lib/v2/db/types.ts";
import { suggestMattersForConversation } from "../src/lib/v2/intelligence/user-matter.ts";

const db = await startTestDb();
try {
  const userId = await upsertUser("matter-picker@example.com");
  const accountId = await upsertAccount({
    userId,
    provider: "microsoft",
    email: "matter-picker@example.com",
  });
  const conversation = await db.pool.query<{ id: string }>(
    `insert into seer.conversations
       (account_id, provider_conversation_id, subject, folders, function_name)
     values ($1, 'provider-picker', 'RD007704 stability extension',
             array['inbox']::text[], 'operations — studies')
     returning id`,
    [accountId],
  );
  const conversationId = asConversationId(conversation.rows[0].id);
  await db.pool.query(
    `insert into seer.messages
       (account_id, conversation_id, provider_message_id, from_email, to_emails,
        sent_at, snippet, body_text, is_unread, is_outgoing)
     values ($1, $2, 'message-picker', 'sandra@roche.com',
             array['matter-picker@example.com'], now(),
             'Amendment for RD007704', 'Please countersign the RD007704 amendment',
             true, false)`,
    [accountId, conversationId],
  );
  await db.pool.query(
    `insert into seer.conversation_decisions
       (account_id, conversation_id, home, proposed_home, summary, rationale,
        owner, veto_reasons, model_version, context_version, is_current, decided_at)
     values ($1, $2, 'undecided', 'matter', 'Countersign the stability amendment',
             'test', 'you', '{}', 'test', 'test', true, now())`,
    [accountId, conversationId],
  );

  const related = await db.pool.query<{ id: string }>(
    `insert into seer.matters
       (account_id, title, short_title, org_unit, function_name)
     values ($1, 'Roche RD007704 stability extension',
             'RD007704 stability', 'roche', 'operations — studies')
     returning id`,
    [accountId],
  );
  await db.pool.query(
    "insert into seer.matter_codes (matter_id, code) values ($1, 'RD007704')",
    [related.rows[0].id],
  );
  await db.pool.query(
    `insert into seer.matters (account_id, title, short_title, org_unit)
     values ($1, 'Unrelated hiring plan', 'Hiring plan', 'internal')`,
    [accountId],
  );

  const suggestions = await suggestMattersForConversation(
    accountId,
    conversationId,
  );
  assert.equal(suggestions.length, 2);
  assert.equal(suggestions[0].matterId, related.rows[0].id);
  assert.equal(suggestions[0].related, true);
  assert.equal(
    suggestions.filter((suggestion) => suggestion.related).length,
    1,
    "the sweep recommends only a conservative match",
  );

  console.log("v3-matter-picker: OK");
} finally {
  await db.stop();
}
