/**
 * A study or event code written by the sender is not proof that a new email
 * continues a live matter.
 *
 * These tests follow the path the product runs for inbound mail: the sync
 * writer stores the conversation, the read batch loads it back with the
 * account's open matters, and the chief-of-staff reader classifies it. The
 * model is the injected reader seam. It returns "matter" — the condition under
 * which promotion safety is supposed to keep an untrusted or incomplete read
 * off Atlas. While a code match skips those checks, or a later lookup attaches
 * the conversation to the matched matter anyway, the assertions below fail.
 *
 * Operations that reuse the same code match but are not this automatic path:
 * - suggestMattersForConversation only ranks a suggestion for the signed-in user
 * - placeConversationOnMatter runs when that user files mail onto a matter
 * - findMatterByRef attaches a yielded insight, not the conversation itself
 */
import assert from "node:assert/strict";
import type { Pool } from "pg";
import { startTestDb } from "./v2-testdb.mts";
import { upsertUser, upsertAccount } from "../src/lib/v2/db/accounts.ts";
import { writeConversationPage } from "../src/lib/v2/sync/repository.ts";
import { readBatch } from "../src/lib/v2/intelligence/read-batch.ts";
import type { ReaderModel } from "../src/lib/v2/intelligence/reader.ts";
import type { Conversation, Message } from "../src/lib/v2/providers/types.ts";
import type { ReadResult } from "../src/lib/v2/intelligence/schema.ts";

const OWN = "conall@rditrials.com";
const ROCHE_CODE = "RD007704";
const ABBOTT_CODE = "RCD2818";

const WEAK_READ: ReadResult = {
  home: "matter",
  summary: "Review request",
  rationale: "The context says this continues a live matter",
  owner: "nobody",
  ask: "nothing — informational",
  obligation: false,
  matterRef: "Study review",
  yields: [],
  evidence: [],
};

const QUALIFIED_READ: ReadResult = {
  home: "matter",
  summary: "Approval still outstanding",
  rationale: "Direct approval request",
  owner: "you",
  ask: "Approve the sample review",
  obligation: true,
  matterRef: "Sample review approval",
  yields: [],
  evidence: [],
};

function message(input: {
  id: string;
  from: string;
  to: string[];
  bodyText: string | null;
  bodyHtml?: string | null;
  snippet: string;
}): Message {
  return {
    providerMessageId: input.id,
    from: { email: input.from },
    to: input.to.map((email) => ({ email })),
    cc: [],
    sentAt: "2026-08-08T10:00:00Z",
    snippet: input.snippet,
    bodyHtml: input.bodyHtml ?? null,
    bodyText: input.bodyText,
    isUnread: true,
    isOutgoing: false,
    attachments: [],
  };
}

function conversation(input: {
  id: string;
  subject: string;
  message: Message;
}): Conversation {
  return {
    providerConversationId: input.id,
    subject: input.subject,
    messages: [input.message],
    lastMessageAt: "2026-08-08T10:00:00Z",
  };
}

type DecisionRow = {
  home: string;
  proposed_home: string;
  matter_id: string | null;
  veto_reasons: string[];
};

async function decisionFor(pool: Pool, providerId: string): Promise<DecisionRow> {
  const result = await pool.query<DecisionRow>(
    `select d.home, d.proposed_home, d.matter_id, d.veto_reasons
       from seer.conversation_decisions d
       join seer.conversations c on c.id = d.conversation_id
      where c.provider_conversation_id = $1
        and d.is_current`,
    [providerId],
  );
  assert.equal(result.rowCount, 1, `${providerId} must be classified`);
  return result.rows[0];
}

async function linkedTo(pool: Pool, providerId: string, matterId: string): Promise<number> {
  const result = await pool.query<{ n: number }>(
    `select count(*)::int as n
       from seer.matter_conversations mc
       join seer.conversations c on c.id = mc.conversation_id
      where c.provider_conversation_id = $1
        and mc.matter_id = $2`,
    [providerId, matterId],
  );
  return result.rows[0].n;
}

async function codesOf(pool: Pool, matterId: string): Promise<string[]> {
  const result = await pool.query<{ code: string }>(
    `select code from seer.matter_codes where matter_id = $1 order by code`,
    [matterId],
  );
  return result.rows.map((row) => row.code);
}

const db = await startTestDb();
try {
  const userId = await upsertUser(OWN);
  const accountId = await upsertAccount({
    userId,
    provider: "google",
    email: OWN,
  });

  const roche = await db.pool.query<{ id: string }>(
    `insert into seer.matters (account_id, title, org_unit, title_source)
     values ($1, 'Roche sample stability', 'roche', 'inferred')
     returning id`,
    [accountId],
  );
  const rocheId = roche.rows[0].id;
  await db.pool.query(
    `insert into seer.matter_codes (matter_id, code) values ($1, $2)`,
    [rocheId, ROCHE_CODE],
  );

  const abbott = await db.pool.query<{ id: string }>(
    `insert into seer.matters (account_id, title, org_unit, title_source)
     values ($1, 'Abbott sourcing event', 'abbott', 'inferred')
     returning id`,
    [accountId],
  );
  const abbottId = abbott.rows[0].id;
  await db.pool.query(
    `insert into seer.matter_codes (matter_id, code) values ($1, $2)`,
    [abbottId, ABBOTT_CODE],
  );

  const programme = await db.pool.query<{ id: string }>(
    `insert into seer.matters (account_id, title, org_unit, title_source)
     values ($1, 'Sample stability programme', 'roche', 'inferred')
     returning id`,
    [accountId],
  );
  const programmeId = programme.rows[0].id;

  const clinic = await db.pool.query<{ id: string }>(
    `insert into seer.matters (account_id, title, org_unit, title_source)
     values ($1, 'Clinic assay review', 'roche', 'inferred')
     returning id`,
    [accountId],
  );
  const clinicId = clinic.rows[0].id;
  await db.pool.query(
    `insert into seer.matter_codes (matter_id, code) values ($1, 'TZC0430556')`,
    [clinicId],
  );

  const userMatter = await db.pool.query<{ id: string }>(
    `insert into seer.matters (account_id, title, org_unit, title_source)
     values ($1, 'Canadian startup CRO monitoring lead', 'sales', 'user')
     returning id`,
    [accountId],
  );
  const userMatterId = userMatter.rows[0].id;

  await db.pool.query(
    `insert into seer.people (account_id, email, tier, vip)
     values ($1, 'sam.lee@clinic.example', 'known', false)`,
    [accountId],
  );

  const strangerWeak = "stranger-weak-rd";
  const strangerBody = "stranger-weak-rcd";
  const strangerQualified = "stranger-qualified-rd";
  const internalQualified = "internal-qualified-rd";
  const counterpartyWeak = "counterparty-weak-rd";
  const counterpartyWords = "counterparty-weak-words";
  const counterpartyQualified = "counterparty-qualified-rd";
  const knownWeak = "known-weak-rd";
  const knownQualified = "known-qualified-rd";
  const titledWeak = "titled-weak";

  const stored = await writeConversationPage(accountId, "inbox", [
    conversation({
      id: strangerWeak,
      subject: "Review RD-007704",
      message: message({
        id: "msg-stranger-weak",
        from: "outsider@vendor-list.example",
        to: ["vendors@broadcast.example"],
        bodyText: "The packet is ready for a look. WI42.",
        snippet: "The packet is ready for a look.",
      }),
    }),
    conversation({
      id: strangerBody,
      subject: "Weekly update",
      message: message({
        id: "msg-stranger-body",
        from: "outsider2@vendor-list.example",
        to: ["vendors@broadcast.example"],
        bodyText: null,
        bodyHtml: "<p>See event RCD_2818 for the sourcing notes. WI15.</p>",
        snippet: "Weekly update",
      }),
    }),
    conversation({
      id: strangerQualified,
      subject: "Approval needed",
      message: message({
        id: "msg-stranger-qualified",
        from: "alex.rivera@other-lab.example",
        to: [OWN],
        bodyText:
          "Hi Conall, please approve the pending signature for study RD-007704 before Friday. Reference SOP999.",
        snippet: "Please approve the pending signature",
      }),
    }),
    conversation({
      id: internalQualified,
      subject: "Internal approval",
      message: message({
        id: "msg-internal-qualified",
        from: "colleague@rditrials.com",
        to: [OWN],
        bodyText:
          "Hi Conall, please approve the pending signature for study RD-007704. Reference WI88.",
        snippet: "Please approve the pending signature",
      }),
    }),
    conversation({
      id: counterpartyWeak,
      subject: "Notes RD-007704",
      message: message({
        id: "msg-counterparty-weak",
        from: "raiane.gaspar@roche.com",
        to: ["vendors@broadcast.example"],
        bodyText: "Status note for RD-007704. EUR12 is a separate identifier.",
        snippet: "Status note",
      }),
    }),
    conversation({
      id: counterpartyWords,
      subject: "Sample stability programme notes",
      message: message({
        id: "msg-counterparty-words",
        from: "raiane.notes@roche.com",
        to: ["vendors@broadcast.example"],
        bodyText: "A short note about the sample stability programme.",
        snippet: "A short note",
      }),
    }),
    conversation({
      id: counterpartyQualified,
      subject: "Countersignature",
      message: message({
        id: "msg-counterparty-qualified",
        from: "raiane.sign@roche.com",
        to: [OWN],
        bodyText: "Hi Conall, please countersign the amendment for study RD-007704.",
        snippet: "Please countersign the amendment",
      }),
    }),
    conversation({
      id: knownWeak,
      subject: "Status TZC0430556",
      message: message({
        id: "msg-known-weak",
        from: "sam.lee@clinic.example",
        to: ["vendors@broadcast.example"],
        bodyText: "FYI the TZC0430556 packet moved. EUR44.",
        snippet: "FYI the packet moved",
      }),
    }),
    conversation({
      id: knownQualified,
      subject: "Known approval",
      message: message({
        id: "msg-known-qualified",
        from: "sam.lee@clinic.example",
        to: [OWN],
        bodyText: "Hi Conall, please approve the pending signature for study TZC0430556.",
        snippet: "Please approve the pending signature",
      }),
    }),
    conversation({
      id: titledWeak,
      subject: "Canadian startup CRO monitoring lead",
      message: message({
        id: "msg-titled-weak",
        from: "outsider3@vendor-list.example",
        to: ["vendors@broadcast.example"],
        bodyText: "Sharing the latest note on this topic.",
        snippet: "Sharing the latest note",
      }),
    }),
  ], []);
  assert.equal(stored.failed, 0, "inbound conversations must be stored");
  assert.equal(stored.stored, 10);

  const seen = new Map<string, { contextText: string; liveMatterId: string | null }>();
  const qualifiedIds = new Set([
    strangerQualified,
    internalQualified,
    counterpartyQualified,
    knownQualified,
  ]);
  // The model returns matter whether or not the context hints at continuity.
  // Deleting the hint, while still accepting a matter classification, must not
  // make these tests pass.
  const model: ReaderModel = async (input) => {
    seen.set(input.conversation.providerConversationId, {
      contextText: input.contextText,
      liveMatterId: input.routingFacts.liveMatterId,
    });
    return qualifiedIds.has(input.conversation.providerConversationId)
      ? QUALIFIED_READ
      : WEAK_READ;
  };

  const batch = await readBatch(accountId, OWN, model, { limit: 20, concurrency: 1 });
  assert.equal(batch.failed, 0, "classification must persist");
  assert.equal(batch.decided, 10);

  const failures: string[] = [];
  const openMatterIds = [rocheId, abbottId, programmeId, clinicId, userMatterId];
  function observed(providerId: string): string {
    const observation = seen.get(providerId);
    if (!observation) return "reader model was not called";
    const hinted = observation.contextText.includes("may continue the live matter");
    return `liveMatterId=${observation.liveMatterId ?? "null"}${hinted ? " continuation-hint" : ""}`;
  }

  async function expectKeptOff(providerId: string, vetoes: string[]): Promise<void> {
    const decision = await decisionFor(db.pool, providerId);
    const missing = vetoes.filter((reason) => !decision.veto_reasons.includes(reason));
    const linkedMatters: string[] = [];
    for (const matterId of openMatterIds) {
      if ((await linkedTo(db.pool, providerId, matterId)) !== 0) linkedMatters.push(matterId);
    }
    if (decision.proposed_home !== "matter") {
      failures.push(`${providerId}: model proposal was ${decision.proposed_home}`);
    }
    if (decision.home !== "record") {
      failures.push(
        `${providerId}: home ${decision.home} (vetoes ${decision.veto_reasons.join(",") || "none"}; matter ${decision.matter_id}; ${observed(providerId)})`,
      );
    }
    if (decision.matter_id !== null && openMatterIds.includes(decision.matter_id)) {
      failures.push(`${providerId}: decision is filed on an existing matter ${decision.matter_id}`);
    }
    if (linkedMatters.length > 0) {
      failures.push(`${providerId}: conversation is linked to ${linkedMatters.join(",")}`);
    }
    if (missing.length > 0) {
      failures.push(
        `${providerId}: missing vetoes ${missing.join(",")} (got ${decision.veto_reasons.join(",") || "none"})`,
      );
    }
  }

  const weakVetoes = [
    "matter_untrusted_sender",
    "matter_not_direct",
    "matter_no_open_work",
    "matter_owner_nobody",
  ];
  await expectKeptOff(strangerWeak, weakVetoes);
  await expectKeptOff(strangerBody, weakVetoes);
  await expectKeptOff(counterpartyWeak, weakVetoes);
  await expectKeptOff(counterpartyWords, weakVetoes);
  // A known person still has to clear direct-address, open-work, and owner.
  await expectKeptOff(knownWeak, [
    "matter_not_direct",
    "matter_no_open_work",
    "matter_owner_nobody",
  ]);
  await expectKeptOff(titledWeak, weakVetoes);

  async function expectNotJoined(providerId: string, matterId: string): Promise<void> {
    const decision = await decisionFor(db.pool, providerId);
    const links = await linkedTo(db.pool, providerId, matterId);
    if (links !== 0 || decision.matter_id === matterId) {
      failures.push(
        `${providerId}: qualified read from a sender outside the matter was filed on it (home ${decision.home}, matter ${decision.matter_id})`,
      );
    }
  }

  // A read that would pass every promotion check still must not join the
  // client matter when the only relation is a code the sender wrote, unless
  // the sender's domain is that counterparty or the sender is a known person.
  await expectNotJoined(strangerQualified, rocheId);
  await expectNotJoined(internalQualified, rocheId);

  const rocheCodes = await codesOf(db.pool, rocheId);
  if (rocheCodes.includes("WI42") || rocheCodes.includes("SOP999") || rocheCodes.includes("WI88") || rocheCodes.includes("EUR12") || rocheCodes.includes("EUR44")) {
    failures.push(`Roche matter absorbed sender-written codes: ${rocheCodes.join(",")}`);
  }
  const abbottCodes = await codesOf(db.pool, abbottId);
  if (abbottCodes.includes("WI15")) {
    failures.push(`Abbott matter absorbed a sender-written code: ${abbottCodes.join(",")}`);
  }
  const clinicCodes = await codesOf(db.pool, clinicId);
  if (clinicCodes.includes("EUR44")) {
    failures.push(`Clinic matter absorbed a sender-written code: ${clinicCodes.join(",")}`);
  }

  // Continuity that is still allowed: the counterparty, and a known person.
  const counterpartyDecision = await decisionFor(db.pool, counterpartyQualified);
  assert.equal(counterpartyDecision.home, "matter", "counterparty read stays a matter");
  assert.equal(counterpartyDecision.matter_id, rocheId, "counterparty read continues the Roche matter");
  assert.equal(await linkedTo(db.pool, counterpartyQualified, rocheId), 1);

  const knownDecision = await decisionFor(db.pool, knownQualified);
  assert.equal(knownDecision.home, "matter", "known-person read stays a matter");
  assert.equal(knownDecision.matter_id, clinicId, "known-person read continues the clinic matter");
  assert.equal(await linkedTo(db.pool, knownQualified, clinicId), 1);

  if (failures.length > 0) {
    throw new Error(`matter-code promotion safety failed:\n${failures.join("\n")}`);
  }
  console.log("v2-matter-code-safety: OK");
} finally {
  await db.stop();
}
