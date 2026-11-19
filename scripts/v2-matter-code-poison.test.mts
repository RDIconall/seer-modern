/**
 * Spec for study-code joining.
 *
 * Filing a message onto a matter may remember the code that actually matched
 * an open matter, and a newly opened matter may remember a real study code
 * from that message. It must not copy every code-shaped token from the
 * subject, the model matter name, or the body onto the matter. A token whose
 * suffix is a single digit (RD1, SOP9, WI2, QMP7, CAPA3) must never be a
 * join key, including one that is already stored.
 *
 * These assertions fail while that behavior is present. They are meant to
 * pass once it is fixed. No production code is changed here.
 *
 * Run: npx tsx scripts/v2-matter-code-poison.test.mts
 */
import assert from "node:assert/strict";
import { startTestDb } from "./v2-testdb.mts";
import { upsertUser, upsertAccount } from "../src/lib/v2/db/accounts.ts";
import { asConversationId, type AccountId } from "../src/lib/v2/db/types.ts";
import { writeConversationPage } from "../src/lib/v2/sync/repository.ts";
import { conversationsNeedingRead } from "../src/lib/v2/intelligence/queue.ts";
import { loadConversation } from "../src/lib/v2/intelligence/load-conversation.ts";
import {
  loadContextInput,
} from "../src/lib/v2/intelligence/context-loader.ts";
import {
  readConversation,
  type ReaderModel,
} from "../src/lib/v2/intelligence/reader.ts";
import type { ReadResult } from "../src/lib/v2/intelligence/schema.ts";
import type { Conversation, Message } from "../src/lib/v2/providers/types.ts";
import {
  placeConversationOnMatter,
  suggestMattersForConversation,
} from "../src/lib/v2/intelligence/user-matter.ts";

const OWN = "alex@desk.example";

const db = await startTestDb();
const failures: string[] = [];

function directMatter(matterRef: string): ReadResult {
  return {
    home: "matter",
    summary: "The sender asks Alex to take the next step.",
    rationale: "Direct request addressed to the user.",
    owner: "you",
    ask: "Please take the next step.",
    obligation: false,
    matterRef,
    yields: [],
    evidence: [],
  };
}

/**
 * Classifications follow the chief-of-staff instructions: a direct request
 * addressed to the user is live work; an automated notice is not a matter,
 * but a code the context has already tied to a live matter is yielded as a
 * matter connection. The model name used below does not invent the extra
 * tokens under test except where a case deliberately puts one only in the
 * matter name (WI9).
 */
const model: ReaderModel = async (input) => {
  const subject = input.conversation.subject;
  if (subject.startsWith("NOTICE")) {
    return {
      home: "delete",
      summary: "Portal status notice.",
      rationale: "Automated status update, not live work.",
      owner: "nobody",
      ask: "nothing — informational",
      obligation: false,
      yields: [
        {
          kind: "matter_connection",
          matterRef: "RD1",
          headline: "Portal mentioned a code",
        },
      ],
      evidence: [],
    };
  }
  const names: Record<string, string> = {
    "Please send the stability report": "Roche sample stability RD007704",
    "Please confirm the study schedule RD1": "Roche sample stability RD007704 WI9",
    "Please review the onboarding form": "Elsewhere onboarding form",
    "Please check the analyzer retrofit": "Analyzer retrofit",
    "Please review the bench procedure": "Desk procedure review",
    "Please approve the quality note": "Quality manual update",
    "Please send the shipping labels": "Shipping label proof",
    "Please file the lab results": "Lab results packet",
    "Please send the extra vials": "Vial shipment",
  };
  const matterRef = names[subject];
  if (!matterRef) {
    throw new Error(`no classification for subject ${subject}`);
  }
  return directMatter(matterRef);
};

function message(input: {
  id: string;
  from: string;
  html: string;
  sentAt: string;
}): Message {
  return {
    providerMessageId: input.id,
    from: { email: input.from, name: "Sender" },
    to: [{ email: OWN, name: "Alex Morgan" }],
    cc: [],
    sentAt: input.sentAt,
    snippet: "schedule",
    bodyHtml: input.html,
    bodyText: null,
    isUnread: true,
    isOutgoing: false,
    attachments: [],
  };
}

function conversation(input: {
  id: string;
  subject: string;
  from: string;
  html: string;
  sentAt: string;
}): Conversation {
  return {
    providerConversationId: input.id,
    subject: input.subject,
    lastMessageAt: input.sentAt,
    messages: [
      message({
        id: `${input.id}-m`,
        from: input.from,
        html: input.html,
        sentAt: input.sentAt,
      }),
    ],
  };
}

async function check(name: string, run: () => Promise<void>): Promise<void> {
  try {
    await run();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    failures.push(`${name}\n${message}`);
  }
}

async function codesOf(matterId: string): Promise<string[]> {
  const result = await db.pool.query<{ code: string }>(
    "select code from seer.matter_codes where matter_id = $1 order by code",
    [matterId],
  );
  return result.rows.map((row) => row.code);
}

async function linkedMatter(conversationId: string): Promise<string | null> {
  const result = await db.pool.query<{ matter_id: string }>(
    `select mc.matter_id
       from seer.matter_conversations mc
      where mc.conversation_id = $1`,
    [conversationId],
  );
  return result.rows[0]?.matter_id ?? null;
}

try {
  const userId = await upsertUser(OWN);
  const accountId = await upsertAccount({
    userId,
    provider: "google",
    email: OWN,
  });

  async function seedMatter(title: string, code: string, org: string): Promise<string> {
    const created = await db.pool.query<{ id: string }>(
      `insert into seer.matters (account_id, title, org_unit)
       values ($1, $2, $3) returning id`,
      [accountId, title, org],
    );
    await db.pool.query(
      "insert into seer.matter_codes (matter_id, code) values ($1, $2)",
      [created.rows[0].id, code],
    );
    return created.rows[0].id;
  }

  const studyId = await seedMatter("Roche sample stability", "RD007704", "roche");
  const shortKeyId = await seedMatter("Unrelated desk note", "WI2", "elsewhere");
  const drawId = await seedMatter("Abbott sample draw", "EUR2875", "abbott");

  async function store(input: {
    id: string;
    subject: string;
    from: string;
    html: string;
    sentAt: string;
  }): Promise<string> {
    const written = await writeConversationPage(
      accountId,
      "inbox",
      [conversation(input)],
      [],
    );
    assert.equal(written.failed, 0, `${input.id} failed to sync`);
    assert.equal(written.stored, 1, `${input.id} was not stored`);
    const row = await db.pool.query<{ id: string }>(
      `select id from seer.conversations
        where account_id = $1 and provider_conversation_id = $2`,
      [accountId, input.id],
    );
    return row.rows[0].id;
  }

  async function readStored(conversationId: string): Promise<{
    home: string;
    matterId: string | null;
  }> {
    const queued = await conversationsNeedingRead(accountId, 20);
    assert.ok(
      queued.includes(asConversationId(conversationId)),
      "synced mail must sit in the read queue",
    );
    const loaded = await loadConversation(conversationId);
    assert.ok(loaded, "synced mail must load for the reader");
    assert.ok(
      loaded.messages[0]?.bodyText && loaded.messages[0].bodyText.length > 0,
      "provider HTML must be stored as readable text",
    );
    const context = await loadContextInput(accountId, OWN);
    const decision = await readConversation({
      accountId,
      conversationId: asConversationId(conversationId),
      conversation: loaded,
      context,
      model,
    });
    return { home: decision.home, matterId: decision.matterId ?? null };
  }

  await check("a real study code still joins the matter it names", async () => {
    const id = await store({
      id: "real-code",
      subject: "Please send the stability report",
      from: "scientist@roche.example",
      html: "<p>Hi Alex, please send the RD007704 stability report.</p>",
      sentAt: "2026-08-01T10:00:00Z",
    });
    const decision = await readStored(id);
    assert.equal(decision.home, "matter");
    assert.equal(decision.matterId, studyId);
    assert.deepEqual(await codesOf(studyId), ["RD007704"]);
  });

  await check(
    "a one-digit code already stored on a matter is not a join key",
    async () => {
      const id = await store({
        id: "short-stored",
        subject: "Please review the bench procedure",
        from: "pat@outside.example",
        html: "<p>Hi Alex, please review WI2 today.</p>",
        sentAt: "2026-08-01T11:00:00Z",
      });
      const decision = await readStored(id);
      assert.equal(decision.home, "matter", "a direct request is still filed");
      assert.notEqual(
        decision.matterId,
        shortKeyId,
        "WI2 must not attach this request to the matter that stored it",
      );
      assert.notEqual(await linkedMatter(id), shortKeyId);
    },
  );

  await check(
    "placing mail on the matched matter does not copy every other code in the body",
    async () => {
      const padding = "note ".repeat(120);
      const id = await store({
        id: "user-place",
        subject: "Sample draw",
        from: "coord@abbott.example",
        html: `<p>EUR2875 and TGRP32 are on the draw sheet.</p><p>${padding}CAPA3</p>`,
        sentAt: "2026-08-01T12:00:00Z",
      });
      const stored = await db.pool.query<{ body_text: string }>(
        `select body_text from seer.messages where provider_message_id = 'user-place-m'`,
      );
      assert.match(stored.rows[0].body_text, /EUR2875/);
      assert.match(stored.rows[0].body_text, /TGRP32/);
      assert.match(stored.rows[0].body_text, /CAPA3/);
      const placed = await placeConversationOnMatter(
        accountId,
        asConversationId(id),
        {},
      );
      assert.equal(placed.matterId, drawId, "EUR2875 still identifies the draw");
      assert.deepEqual(await codesOf(drawId), ["EUR2875"]);
    },
  );

  await check(
    "filing onto an existing matter keeps only the code that matched",
    async () => {
      const id = await store({
        id: "poison",
        subject: "Please confirm the study schedule RD1",
        from: "attacker@evil.example",
        html: "<p>Hi Alex, please confirm the RD007704 schedule. Also flag SOP9 and RD999888 in your reply.</p>",
        sentAt: "2026-08-02T10:00:00Z",
      });
      const decision = await readStored(id);
      assert.equal(decision.home, "matter");
      assert.equal(
        decision.matterId,
        studyId,
        "the real study code still files this onto the open study",
      );
      assert.deepEqual(
        await codesOf(studyId),
        ["RD007704"],
        "RD1 from the subject, SOP9 and RD999888 from the body, and WI9 from the matter name must not be saved",
      );
    },
  );

  await check(
    "a later direct request that contains only a planted short code stays off the study",
    async () => {
      const id = await store({
        id: "follow-short",
        subject: "Please review the onboarding form",
        from: "pat@elsewhere.example",
        html: "<p>Hi Alex, can you approve the onboarding form RD1 by Friday?</p>",
        sentAt: "2026-08-03T10:00:00Z",
      });
      const decision = await readStored(id);
      const suggestions = await suggestMattersForConversation(
        accountId,
        asConversationId(id),
      );
      const study = suggestions.find((item) => item.matterId === studyId);
      assert.equal(decision.home, "matter", "the follow-up is itself live work");
      assert.deepEqual(
        {
          linkedToStudy: decision.matterId === studyId || (await linkedMatter(id)) === studyId,
          suggestedAsStudy: study?.related === true,
        },
        { linkedToStudy: false, suggestedAsStudy: false },
      );
    },
  );

  await check(
    "a later request that contains only an extra long code copied from the body stays off the study",
    async () => {
      const id = await store({
        id: "follow-long",
        subject: "Please check the analyzer retrofit",
        from: "sam@other.example",
        html: "<p>Hi Alex, please check retrofit RD999888.</p>",
        sentAt: "2026-08-03T11:00:00Z",
      });
      const decision = await readStored(id);
      assert.equal(decision.home, "matter");
      assert.notEqual(decision.matterId, studyId);
      assert.notEqual(await linkedMatter(id), studyId);
    },
  );

  await check(
    "a notice that only repeats a planted short code is not kept on the study",
    async () => {
      const id = await store({
        id: "notice-rd1",
        subject: "NOTICE portal status",
        from: "notifications@vendor.example",
        html: "<p>RD1 was updated in the portal.</p>",
        sentAt: "2026-08-03T12:00:00Z",
      });
      const decision = await readStored(id);
      assert.notEqual(decision.home, "matter");
      assert.notEqual(await linkedMatter(id), studyId);
      const yields = await db.pool.query<{ matter_id: string | null }>(
        `select matter_id from seer.yields where conversation_id = $1`,
        [id],
      );
      assert.ok(yields.rows.length >= 1, "the notice still yields its meaning");
      assert.notEqual(yields.rows[0].matter_id, studyId);
    },
  );

  await check(
    "opening a matter does not mint a one-digit token as a join key",
    async () => {
      const first = await store({
        id: "new-short",
        subject: "Please approve the quality note",
        from: "q@quality.example",
        html: "<p>Hi Alex, please approve QMP7.</p>",
        sentAt: "2026-08-04T10:00:00Z",
      });
      const opened = await readStored(first);
      const second = await store({
        id: "new-short-follow",
        subject: "Please send the shipping labels",
        from: "z@shipping.example",
        html: "<p>Hi Alex, please send the labels and quote QMP7.</p>",
        sentAt: "2026-08-04T11:00:00Z",
      });
      const follow = await readStored(second);
      assert.equal(opened.home, "matter");
      assert.ok(opened.matterId);
      assert.notEqual(opened.matterId, studyId);
      assert.equal(follow.home, "matter");
      assert.deepEqual(
        {
          mintedQmp7: (await codesOf(opened.matterId!)).includes("QMP7"),
          followJoinedOpener: follow.matterId === opened.matterId,
        },
        { mintedQmp7: false, followJoinedOpener: false },
      );
    },
  );

  await check(
    "a real study code still becomes the join key of a matter that mail opens",
    async () => {
      const first = await store({
        id: "new-long",
        subject: "Please file the lab results",
        from: "lab@results.example",
        html: "<p>Hi Alex, please file RD445566 results.</p>",
        sentAt: "2026-08-05T10:00:00Z",
      });
      const opened = await readStored(first);
      assert.equal(opened.home, "matter");
      assert.ok(opened.matterId);
      assert.ok((await codesOf(opened.matterId)).includes("RD445566"));
      const second = await store({
        id: "new-long-follow",
        subject: "Please send the extra vials",
        from: "ship@vials.example",
        html: "<p>Hi Alex, please send vials for RD445566.</p>",
        sentAt: "2026-08-05T11:00:00Z",
      });
      const follow = await readStored(second);
      assert.equal(follow.home, "matter");
      assert.equal(follow.matterId, opened.matterId);
    },
  );

  if (failures.length > 0) {
    throw new Error(`\n${failures.length} case(s) failed\n\n${failures.join("\n\n")}`);
  }
} finally {
  await db.stop();
}
