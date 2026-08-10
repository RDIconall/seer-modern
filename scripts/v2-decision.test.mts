/**
 * Task 6 gate: veto-only safety and one-current-decision persistence. These are
 * the structural guarantees behind "no decision worse than a naive full read"
 * and "nothing actionable reaches Safe to delete".
 */
import assert from "node:assert/strict";
import { startTestDb } from "./v2-testdb.mts";
import { validateDelete, type SafetyFacts } from "../src/lib/v2/intelligence/safety.ts";
import { saveDecision, currentDecision } from "../src/lib/v2/intelligence/repository.ts";
import { upsertUser, upsertAccount } from "../src/lib/v2/db/accounts.ts";
import { asConversationId } from "../src/lib/v2/db/types.ts";

const SAFE: SafetyFacts = {
  ownerIsYou: false,
  hasOpenAsk: false,
  hasPendingObligation: false,
  liveMatterId: null,
  senderIsKnown: false,
  senderIsInternal: false,
  yieldPersisted: true,
  hadCompleteContext: true,
};

// --- Veto-only safety (pure) -------------------------------------------------

// A genuinely disposable email with no contradicting facts is deletable.
assert.equal(validateDelete({ home: "delete" }, SAFE).home, "delete");

// The Salesforce "ACTION REQUIRED" case: an obligation remains → never deleted.
{
  const r = validateDelete({ home: "delete" }, { ...SAFE, hasPendingObligation: true });
  assert.equal(r.home, "undecided");
  assert.ok(r.vetoReasons.includes("pending_obligation"));
}

// Owner is you → veto.
assert.equal(validateDelete({ home: "delete" }, { ...SAFE, ownerIsYou: true }).home, "undecided");

// Live matter (e.g. a newsletter touching the Roche matter) → veto.
assert.equal(
  validateDelete({ home: "delete" }, { ...SAFE, liveMatterId: "m1" }).home,
  "undecided",
);

// Known sender (a real contact) → veto.
assert.equal(validateDelete({ home: "delete" }, { ...SAFE, senderIsKnown: true }).home, "undecided");

// Yield detected but not persisted → veto (keep meaning before deleting husk).
assert.equal(
  validateDelete({ home: "delete" }, { ...SAFE, yieldPersisted: false }).home,
  "undecided",
);

// Incomplete context → veto.
assert.equal(
  validateDelete({ home: "delete" }, { ...SAFE, hadCompleteContext: false }).home,
  "undecided",
);

// Safety CANNOT change a matter/record/undecided, ever — not even with unsafe
// facts. It is veto-only, never a classifier.
for (const home of ["matter", "record", "undecided"] as const) {
  const r = validateDelete({ home }, { ...SAFE, ownerIsYou: true, liveMatterId: "m1" });
  assert.equal(r.home, home, `safety must never reclassify ${home}`);
  assert.deepEqual(r.vetoReasons, []);
}

// --- Persistence: one current decision per conversation ----------------------

const db = await startTestDb();
try {
  const userId = await upsertUser("dec@example.com");
  const accountId = await upsertAccount({ userId, provider: "google", email: "dec@example.com" });
  const convRow = await db.pool.query<{ id: string }>(
    `insert into seer.conversations (account_id, provider_conversation_id, subject)
       values ($1, 'conv-1', 'Test') returning id`,
    [accountId],
  );
  const conversationId = asConversationId(convRow.rows[0].id);

  await saveDecision({
    accountId,
    conversationId,
    home: "delete",
    proposedHome: "delete",
    summary: "Newsletter",
    rationale: "Disposable industry newsletter",
    owner: "nobody",
    vetoReasons: [],
    yields: [{ kind: "fact", headline: "Industry note" }],
    evidence: [{ ref: "person:news@x.com", provenance: "observed" }],
  });

  // A second read supersedes the first; only one row stays current.
  const second = await saveDecision({
    accountId,
    conversationId,
    home: "undecided",
    proposedHome: "delete",
    summary: "Newsletter, but touches Roche",
    rationale: "Vetoed: live matter",
    owner: "nobody",
    matterId: null,
    vetoReasons: ["live_matter"],
    yields: [{ kind: "matter_connection", matterRef: "Roche anti-TPO", headline: "FDA clearance mentions Roche" }],
    evidence: [{ ref: "matter:roche", provenance: "inference" }],
  });

  const current = await currentDecision(conversationId);
  assert.equal(current?.id, second.id);
  assert.equal(current?.home, "undecided");
  assert.deepEqual(current?.vetoReasons, ["live_matter"]);

  const currentCount = await db.pool.query(
    "select count(*)::int as n from seer.conversation_decisions where conversation_id = $1 and is_current",
    [conversationId],
  );
  assert.equal(currentCount.rows[0].n, 1, "exactly one decision may be current");

  const total = await db.pool.query(
    "select count(*)::int as n from seer.conversation_decisions where conversation_id = $1",
    [conversationId],
  );
  assert.equal(total.rows[0].n, 2, "history is retained, not overwritten");

  console.log("v2-decision: OK");
} finally {
  await db.stop();
}
