/**
 * Per-mailbox Atlas shelves: propose from evidence, apply without reseeding
 * the CEO org chart.
 */
import assert from "node:assert/strict";
import { startTestDb } from "./v2-testdb.mts";
import { upsertUser, upsertAccount } from "../src/lib/v2/db/accounts.ts";
import {
  applyOperatingModel,
  normalizeProposal,
  proposeOperatingModel,
  sampleCorpus,
} from "../src/lib/v2/intelligence/operating-model.ts";
import {
  DEFAULT_FUNCTIONS,
  listFunctions,
  seedFunctions,
} from "../src/lib/v2/intelligence/functions.ts";

const db = await startTestDb();
try {
  const cleaned = normalizeProposal({
    functions: [
      { name: " House ", why: "repairs" },
      { name: "house", why: "dup" },
      { name: "", why: "blank" },
    ],
    topics: [{ name: "Receipts & stores", why: "keep for taxes" }],
    guidance: "  Family first.  ",
    rationale: "Personal mailbox",
  });
  assert.deepEqual(
    cleaned.functions.map((d) => d.name),
    ["House"],
  );
  assert.equal(cleaned.guidance, "Family first.");

  const userId = await upsertUser("om@example.com");
  const accountId = await upsertAccount({
    userId,
    provider: "google",
    email: "om@example.com",
  });

  await db.pool.query(
    `insert into seer.conversations
       (account_id, provider_conversation_id, subject, folders, is_deleted)
     values
       ($1, 'c-sent', 'Paint quote', array['sent'], false),
       ($1, 'c-trash', '50% off shoes', array['trash'], true),
       ($1, 'c-inbox', 'School trip permission', array['inbox'], false)`,
    [accountId],
  );
  const conv = await db.pool.query<{ id: string }>(
    "select id from seer.conversations where provider_conversation_id = 'c-sent'",
  );
  await db.pool.query(
    `insert into seer.messages
       (account_id, conversation_id, provider_message_id, from_email, snippet, body_text)
     values ($1, $2, 'm-sent', 'painter@x.com', 'Kitchen paint next week', 'Kitchen paint next week')`,
    [accountId, conv.rows[0].id],
  );

  const corpus = await sampleCorpus(accountId, "om@example.com");
  assert.ok(corpus.counts.sent >= 1);
  assert.ok(corpus.counts.trash >= 1);
  assert.ok(corpus.counts.inbox >= 1);

  const { state } = await proposeOperatingModel(accountId, "om@example.com", {
    caller: async () => ({
      functions: [
        { name: "house", why: "quotes and repairs" },
        { name: "family", why: "school" },
      ],
      topics: [{ name: "shopping", why: "promo mail you trash" }],
      guidance: "House projects are matters. Promo mail is a topic.",
      rationale: "Sent a paint quote, trashed a sale, inbox has school.",
    }),
  });
  assert.deepEqual(
    state.proposal?.functions.map((d) => d.name),
    ["house", "family"],
  );
  assert.equal(state.acceptedAt, null, "propose must not apply");

  await seedFunctions(accountId);
  assert.deepEqual(
    await listFunctions(accountId),
    DEFAULT_FUNCTIONS,
    "empty registry still gets first-run defaults",
  );

  await applyOperatingModel(accountId, {
    functions: ["house", "family"],
    topics: ["shopping"],
    guidance: "House projects are matters.",
  });
  assert.equal(await seedFunctions(accountId), 0);
  assert.deepEqual(await listFunctions(accountId), ["house", "family"]);

  console.log("v2-operating-model: ok");
} finally {
  await db.stop();
}
