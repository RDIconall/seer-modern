/**
 * Task 7 gate: the chief-of-staff read produces one safe decision plus business
 * yields. Cases mirror the real inbox: Salesforce "ACTION REQUIRED", a Roche
 * newsletter that must yield a matter connection before deletion, an HBR article
 * matched to an explicit interest, generic news that yields nothing, a known
 * contact with a request, and an incomplete body.
 */
import assert from "node:assert/strict";
import { startTestDb } from "./v2-testdb.mts";
import { upsertUser, upsertAccount } from "../src/lib/v2/db/accounts.ts";
import { readConversation, type ReaderModel } from "../src/lib/v2/intelligence/reader.ts";
import type { ContextInput } from "../src/lib/v2/intelligence/context.ts";
import type { Conversation, Message } from "../src/lib/v2/providers/types.ts";
import { asConversationId, type AccountId } from "../src/lib/v2/db/types.ts";
import type { ReadResult } from "../src/lib/v2/intelligence/schema.ts";

function message(from: string, body: string, subject: string): Message {
  return {
    providerMessageId: `m-${Math.random().toString(36).slice(2)}`,
    from: { email: from },
    to: [{ email: "me@rditrials.com" }],
    cc: [],
    sentAt: "2026-08-08T10:00:00Z",
    snippet: body.slice(0, 40),
    bodyHtml: `<p>${body}</p>`,
    bodyText: body,
    isUnread: true,
    isOutgoing: false,
    attachments: [],
    ...{ subject } as object,
  };
}

async function newConversation(
  pool: import("pg").Pool,
  accountId: AccountId,
  providerId: string,
  subject: string,
  messages: Message[],
): Promise<{ conversation: Conversation; conversationId: ReturnType<typeof asConversationId> }> {
  const row = await pool.query<{ id: string }>(
    `insert into seer.conversations (account_id, provider_conversation_id, subject)
       values ($1, $2, $3) returning id`,
    [accountId, providerId, subject],
  );
  return {
    conversation: {
      providerConversationId: providerId,
      subject,
      messages,
      lastMessageAt: "2026-08-08T10:00:00Z",
    },
    conversationId: asConversationId(row.rows[0].id),
  };
}

const modelFor = (result: ReadResult): ReaderModel => async () => result;

const db = await startTestDb();
try {
  const userId = await upsertUser("me@rditrials.com");
  const accountId = await upsertAccount({ userId, provider: "microsoft", email: "me@rditrials.com" });

  // A real matter row so decision.matter_id (a uuid FK) is valid.
  const matterRow = await db.pool.query<{ id: string }>(
    `insert into seer.matters (account_id, title) values ($1, $2) returning id`,
    [accountId, "Roche anti-TPO study"],
  );
  const context: ContextInput = {
    ownDomain: "rditrials.com",
    people: [{ email: "contact@partner.com", tier: "known", vip: false }],
    matters: [{ id: matterRow.rows[0].id, title: "Roche anti-TPO study" }],
    interests: ["leadership and management"],
  };

  // 1. Salesforce ACTION REQUIRED — even if the model proposes delete, a
  //    pending obligation blocks it. And a correct read shouldn't say
  //    "informational" here, but safety is the backstop either way.
  {
    const { conversation, conversationId } = await newConversation(
      db.pool, accountId, "sf-1", "ACTION REQUIRED: Update SOAP API login()",
      [message("techcomms@salesforce.com", "You must update unsupported API versions", "ACTION REQUIRED")],
    );
    const decision = await readConversation({
      accountId, conversationId, conversation, context,
      model: modelFor({
        home: "delete", summary: "SF API notice", rationale: "looks like a notice",
        owner: "team", ask: "nothing — informational", obligation: true,
        yields: [], evidence: [],
      }),
    });
    assert.equal(decision.home, "undecided", "pending obligation must not be deletable");
    assert.ok(decision.vetoReasons.includes("pending_obligation"));
    assert.equal(decision.proposedHome, "delete", "the model's proposal is retained for audit");
  }

  // 2. Roche newsletter — deletable ONLY because the matter connection is
  //    yielded and persisted first. The husk goes; the meaning stays.
  {
    const { conversation, conversationId } = await newConversation(
      db.pool, accountId, "news-1", "Daily News: FDA clears Roche tests",
      [message("newsletters@360dx.com", "FDA cleared new Roche anti-TPO study assays this month", "Daily News")],
    );
    const decision = await readConversation({
      accountId, conversationId, conversation, context,
      model: modelFor({
        home: "delete", summary: "Industry newsletter", rationale: "Disposable once the Roche item is captured",
        owner: "nobody", obligation: false,
        yields: [{ kind: "matter_connection", matterRef: "Roche anti-TPO study", headline: "FDA cleared Roche anti-TPO assays" }],
        evidence: [{ ref: "matter:roche", provenance: "inference" }],
      }),
    });
    // The context matched the Roche matter, so it is a live-matter veto: kept.
    assert.equal(decision.home, "undecided");
    assert.ok(decision.vetoReasons.includes("live_matter"));
    // The yield was persisted regardless.
    const yields = await db.pool.query(
      "select kind, headline from seer.yields where conversation_id = $1",
      [conversationId],
    );
    assert.equal(yields.rows[0].kind, "matter_connection");
  }

  // 3. HBR article matched to an explicit interest → worth_reading yield.
  {
    const { conversation, conversationId } = await newConversation(
      db.pool, accountId, "hbr-1", "The best leadership teams do this",
      [message("newsletter@hbr.org", "An article on leadership and management for executives", "HBR Weekly")],
    );
    const decision = await readConversation({
      accountId, conversationId, conversation, context,
      model: modelFor({
        home: "delete", summary: "HBR newsletter", rationale: "Read then delete",
        owner: "nobody", obligation: false,
        yields: [{ kind: "worth_reading", headline: "HBR: leadership teams" }],
        evidence: [],
      }),
    });
    assert.equal(decision.home, "delete", "generic-but-interesting reading is deletable after yielding it");
    const yields = await db.pool.query(
      "select kind from seer.yields where conversation_id = $1",
      [conversationId],
    );
    assert.equal(yields.rows[0].kind, "worth_reading");
  }

  // 4. Generic unrelated news → nothing yielded, safely deletable.
  {
    const { conversation, conversationId } = await newConversation(
      db.pool, accountId, "news-2", "Does pure water corrode steel?",
      [message("newsletter@labmanager.com", "A metallurgy article about stainless steel and water", "Lab Manager")],
    );
    const decision = await readConversation({
      accountId, conversationId, conversation, context,
      model: modelFor({
        home: "delete", summary: "Unrelated newsletter", rationale: "No connection to the business",
        owner: "nobody", obligation: false, yields: [], evidence: [],
      }),
    });
    assert.equal(decision.home, "delete");
    assert.deepEqual(decision.vetoReasons, []);
  }

  // 5. Known contact with a real request → never bulk deletable.
  {
    const { conversation, conversationId } = await newConversation(
      db.pool, accountId, "known-1", "Quick question on the SOW",
      [message("contact@partner.com", "Can you confirm the SOW pricing by Friday?", "SOW")],
    );
    const decision = await readConversation({
      accountId, conversationId, conversation, context,
      model: modelFor({
        home: "delete", summary: "Partner note", rationale: "misjudged",
        owner: "you", ask: "Confirm SOW pricing", obligation: false, yields: [], evidence: [],
      }),
    });
    assert.equal(decision.home, "undecided");
    assert.ok(decision.vetoReasons.includes("known_sender"));
    assert.ok(decision.vetoReasons.includes("owner_is_you"));
    assert.ok(decision.vetoReasons.includes("open_ask"));
  }

  // 5b. A live-work read is PROMOTED to a matter and linked, so Atlas is never
  //     empty while `matter` decisions exist.
  {
    const { conversation, conversationId } = await newConversation(
      db.pool, accountId, "matter-1", "Tosoh contract terms",
      [message("legal@tosoh.com", "We need your countersignature on the amended terms", "Tosoh")],
    );
    const decision = await readConversation({
      accountId, conversationId, conversation, context,
      model: modelFor({
        home: "matter", summary: "Tosoh amendment awaiting countersignature",
        rationale: "live negotiation", owner: "you", ask: "Countersign the amendment",
        obligation: true, matterRef: "Tosoh contract amendment", yields: [], evidence: [],
      }),
    });
    assert.equal(decision.home, "matter");
    assert.ok(decision.matterId, "a matter decision must have a matter to belong to");
    const linked = await db.pool.query(
      "select count(*)::int as n from seer.matter_conversations where conversation_id = $1",
      [conversationId],
    );
    assert.equal(linked.rows[0].n, 1, "conversation must be linked to its matter");
    const created = await db.pool.query(
      "select title from seer.matters where id = $1",
      [decision.matterId],
    );
    assert.equal(created.rows[0].title, "Tosoh contract amendment");
  }

  // 6. Incomplete body → undecided, never guessed.
  {
    const providerId = "incomplete-1";
    const row = await db.pool.query<{ id: string }>(
      `insert into seer.conversations (account_id, provider_conversation_id, subject)
         values ($1, $2, $3) returning id`,
      [accountId, providerId, "No body"],
    );
    const conversation: Conversation = {
      providerConversationId: providerId,
      subject: "No body",
      messages: [
        {
          providerMessageId: "x", from: { email: "x@y.com" }, to: [], cc: [],
          sentAt: "2026-08-08T10:00:00Z", snippet: "", bodyHtml: null, bodyText: null,
          isUnread: true, isOutgoing: false, attachments: [],
        },
      ],
      lastMessageAt: "2026-08-08T10:00:00Z",
    };
    let modelCalled = false;
    const decision = await readConversation({
      accountId, conversationId: asConversationId(row.rows[0].id), conversation, context,
      model: async () => { modelCalled = true; throw new Error("should not be called"); },
    });
    assert.equal(decision.home, "undecided");
    assert.equal(modelCalled, false, "an incomplete conversation must not reach the model");
    assert.ok(decision.vetoReasons.includes("incomplete_context"));
  }

  console.log("v2-reader: OK");
} finally {
  await db.stop();
}
