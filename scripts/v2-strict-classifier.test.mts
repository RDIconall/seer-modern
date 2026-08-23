/**
 * Gate: AI returns exactly Atlas / Archive / Delete. Model failure is a retry
 * state, never a fourth answer and never a fabricated Archive.
 */
import assert from "node:assert/strict";
import { startTestDb } from "./v2-testdb.mts";
import { upsertAccount, upsertUser } from "../src/lib/v2/db/accounts.ts";
import { readBatch } from "../src/lib/v2/intelligence/read-batch.ts";
import { conversationsNeedingRead } from "../src/lib/v2/intelligence/queue.ts";
import {
  modelReadResultSchema,
  readResultSchema,
  type ReadResult,
} from "../src/lib/v2/intelligence/schema.ts";

const invalid = {
  home: "undecided",
  summary: "",
  rationale: "I don't know",
  owner: "nobody",
  ask: null,
  obligation: false,
  dueDate: null,
  matterRef: null,
  yields: [],
  evidence: [],
};
assert.equal(modelReadResultSchema.safeParse(invalid).success, false);
assert.equal(
  readResultSchema.safeParse({ ...invalid, ask: undefined }).success,
  false,
);

const db = await startTestDb();
try {
  const userId = await upsertUser("strict-classifier@example.com");
  const accountId = await upsertAccount({
    userId,
    provider: "google",
    email: "strict-classifier@example.com",
  });
  const conversation = await db.pool.query<{ id: string }>(
    `insert into seer.conversations
       (account_id, provider_conversation_id, subject, folders, last_message_at)
     values ($1, 'strict-provider', 'Complete email', array['inbox'], now())
     returning id`,
    [accountId],
  );
  await db.pool.query(
    `insert into seer.messages
       (account_id, conversation_id, provider_message_id, from_email, to_emails,
        sent_at, body_text, snippet, is_unread, is_outgoing)
     values ($1, $2, 'strict-message', 'sender@example.com',
             array['strict-classifier@example.com'], now(),
             'This is complete body text.', 'Complete body', true, false)`,
    [accountId, conversation.rows[0].id],
  );

  const failed = await readBatch(
    accountId,
    "strict-classifier@example.com",
    async () => {
      throw new Error("all model routes unavailable");
    },
    { limit: 10, concurrency: 1 },
  );
  assert.deepEqual(failed, { attempted: 1, decided: 0, failed: 1 });
  const decisionsAfterFailure = await db.pool.query<{ n: number }>(
    `select count(*)::int as n from seer.conversation_decisions
      where conversation_id = $1`,
    [conversation.rows[0].id],
  );
  assert.equal(
    decisionsAfterFailure.rows[0].n,
    0,
    "model failure must not be persisted as Archive or undecided",
  );
  assert.ok(
    (await conversationsNeedingRead(accountId)).some(
      (id) => String(id) === conversation.rows[0].id,
    ),
    "failed classification remains queued",
  );

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
  const recovered = await readBatch(
    accountId,
    "strict-classifier@example.com",
    async () => archive,
    { limit: 10, concurrency: 1 },
  );
  assert.deepEqual(recovered, { attempted: 1, decided: 1, failed: 0 });
  const final = await db.pool.query<{ home: string }>(
    `select home from seer.conversation_decisions
      where conversation_id = $1 and is_current`,
    [conversation.rows[0].id],
  );
  assert.equal(final.rows[0].home, "record");

  console.log("v2-strict-classifier: OK");
} finally {
  await db.stop();
}
