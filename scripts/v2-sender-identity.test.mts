/**
 * Sender identity for a thread is the newest inbound message whose From is
 * not the mailbox. The user's own earlier message must not satisfy the
 * internal-sender, known-sender, relationship, or prior-feedback checks, and
 * must not be the sender described to the model.
 *
 * These assertions fail while the compiler treats the oldest stored From as
 * the person who just wrote. Production reaches that compiler from the read
 * cron (conversationsNeedingRead → loadConversation → readConversation) and
 * from the shadow rebuild (loadStoredConversations → readConversation).
 */
import assert from "node:assert/strict";
import { startTestDb } from "./v2-testdb.mts";
import { upsertUser, upsertAccount } from "../src/lib/v2/db/accounts.ts";
import { asConversationId } from "../src/lib/v2/db/types.ts";
import { writeConversationPage } from "../src/lib/v2/sync/repository.ts";
import { conversationsNeedingRead } from "../src/lib/v2/intelligence/queue.ts";
import {
  clearContextInputCache,
  loadContextInput,
} from "../src/lib/v2/intelligence/context-loader.ts";
import {
  loadConversation,
  loadStoredConversations,
} from "../src/lib/v2/intelligence/load-conversation.ts";
import {
  readConversation,
  type ReaderModel,
  type ReaderModelInput,
} from "../src/lib/v2/intelligence/reader.ts";
import type { ReadResult } from "../src/lib/v2/intelligence/schema.ts";
import { CONTEXT_VERSION } from "../src/lib/v2/intelligence/schema.ts";
import type { Conversation, Message } from "../src/lib/v2/providers/types.ts";
import { buildInboxView } from "../src/lib/v2/view/build.ts";

const MAILBOX = "me@rditrials.com";
const OUTSIDER = "outside.reply@vendor.example";
const COLLEAGUE = "colleague@rditrials.com";
const KNOWN = "partner@known.example";

const matterProposal = (matterRef: string, ask: string): ReadResult => ({
  home: "matter",
  summary: `Track ${matterRef}`,
  rationale: "open request",
  owner: "you",
  ask,
  obligation: false,
  matterRef,
  yields: [],
  evidence: [],
});

function message(input: {
  id: string;
  from: string;
  to: string;
  sentAt: string;
  body: string;
}): Message {
  // Providers mark outgoing by comparing From with the mailbox, then store
  // that flag. The sender check must still key off From, not the array index.
  const from = input.from.toLowerCase();
  return {
    providerMessageId: input.id,
    from: { email: from, name: from },
    to: [{ email: input.to.toLowerCase() }],
    cc: [],
    sentAt: input.sentAt,
    snippet: input.body.slice(0, 80),
    bodyHtml: `<p>${input.body}</p>`,
    bodyText: input.body,
    isUnread: true,
    isOutgoing: from === MAILBOX,
    attachments: [],
  };
}

function thread(
  id: string,
  subject: string,
  messages: Message[],
): Conversation {
  const latest = [...messages].sort((a, b) => a.sentAt.localeCompare(b.sentAt)).at(-1);
  return {
    providerConversationId: id,
    subject,
    lastMessageAt: latest?.sentAt ?? "",
    // Hand the writer the opposite of read order. The loader sorts oldest
    // first; the checker must not treat that first row as the replier.
    messages: [...messages].sort((a, b) => b.sentAt.localeCompare(a.sentAt)),
  };
}

const db = await startTestDb();
const failures: string[] = [];

async function check(name: string, run: () => Promise<void>): Promise<void> {
  try {
    await run();
  } catch (error) {
    const detail = error instanceof Error ? error.stack ?? error.message : String(error);
    failures.push(`${name}\n${detail}`);
  }
}

try {
  const userId = await upsertUser(MAILBOX);
  const accountId = await upsertAccount({
    userId,
    provider: "google",
    email: MAILBOX,
  });

  await db.pool.query(
    `insert into seer.people (account_id, email, tier, vip, vip_source)
     values ($1, $2, 'inner', true, 'user'),
            ($1, $3, 'known', false, null)`,
    [accountId, MAILBOX, KNOWN],
  );

  // A previous Triage correction archived mail from the outsider. The
  // placement loader keys that feedback by the newest inbound From.
  const prior = thread("prior-outsider", "Earlier note", [
    message({
      id: "prior-1",
      from: OUTSIDER,
      to: MAILBOX,
      sentAt: "2026-07-01T10:00:00Z",
      body: "Earlier note with no greeting and no obligation.",
    }),
  ]);
  const priorWrite = await writeConversationPage(accountId, "inbox", [prior], []);
  assert.equal(priorWrite.failed, 0);
  const priorRow = await db.pool.query<{ id: string }>(
    `select id from seer.conversations
      where account_id = $1 and provider_conversation_id = $2`,
    [accountId, prior.providerConversationId],
  );
  await db.pool.query(
    `insert into seer.conversation_decisions
       (account_id, conversation_id, home, proposed_home, summary, rationale,
        owner, model_version, context_version, is_current)
     values ($1, $2, 'record', 'matter', 'archived', 'user moved it off Atlas',
             'nobody', 'user-correction', $3, true)`,
    [accountId, priorRow.rows[0].id, CONTEXT_VERSION],
  );

  clearContextInputCache();
  const context = await loadContextInput(accountId, MAILBOX);
  assert.ok(
    context.people.some((person) => person.email === MAILBOX && person.vip && person.tier === "inner"),
    "setup: the mailbox itself is a VIP on the relationship graph",
  );
  const outsiderPlacement = context.placements?.find(
    (item) => item.senderEmail === OUTSIDER && item.home === "record",
  );
  assert.ok(
    outsiderPlacement && outsiderPlacement.count >= 1,
    "setup: prior feedback is stored against the outsider, not the mailbox",
  );

  async function storedThread(convo: Conversation): Promise<{
    id: string;
    loaded: Conversation;
  }> {
    const written = await writeConversationPage(accountId, "inbox", [convo], []);
    assert.equal(written.failed, 0, written.failed ? "sync failed to store the thread" : "");
    const row = await db.pool.query<{ id: string }>(
      `select id from seer.conversations
        where account_id = $1 and provider_conversation_id = $2`,
      [accountId, convo.providerConversationId],
    );
    const loaded = await loadConversation(row.rows[0].id);
    assert.ok(loaded, "loadConversation returned the stored thread");
    return { id: row.rows[0].id, loaded: loaded! };
  }

  async function readStored(
    id: string,
    loaded: Conversation,
    result: ReadResult,
  ): Promise<{ decisionHome: string; veto: string[]; seen: ReaderModelInput; priority: number; matterId: string | null }> {
    let seen: ReaderModelInput | undefined;
    const model: ReaderModel = async (input) => {
      seen = input;
      return result;
    };
    const decision = await readConversation({
      accountId,
      conversationId: asConversationId(id),
      conversation: loaded,
      context,
      model,
    });
    assert.ok(seen, "the model was invoked with the compiled context");
    const saved = await db.pool.query<{
      home: string;
      veto_reasons: string[];
      priority: number;
      matter_id: string | null;
    }>(
      `select home, veto_reasons, priority, matter_id
         from seer.conversation_decisions
        where conversation_id = $1 and is_current`,
      [id],
    );
    assert.equal(saved.rows[0].home, decision.home);
    return {
      decisionHome: saved.rows[0].home,
      veto: saved.rows[0].veto_reasons,
      seen: seen!,
      priority: saved.rows[0].priority,
      matterId: saved.rows[0].matter_id,
    };
  }

  function outsiderReply(id: string, subject: string, sentAt: string): Message {
    return message({
      id,
      from: OUTSIDER,
      to: MAILBOX,
      sentAt,
      body: "The figures are attached. Please review them and send your comments this week.",
    });
  }

  function userNote(id: string, sentAt: string, body: string): Message {
    return message({
      id,
      from: MAILBOX,
      to: OUTSIDER,
      sentAt,
      body,
    });
  }

  await check("cron path: outsider reply on a thread the mailbox started", async () => {
    const convo = thread("cron-reply", "Q3 figures", [
      userNote("cron-user", "2026-08-01T09:00:00Z", "Can you send the Q3 figures when they are ready?"),
      outsiderReply("cron-reply-msg", "Q3 figures reply", "2026-08-01T15:00:00Z"),
    ]);
    const { id, loaded } = await storedThread(convo);
    assert.equal(loaded.messages[0]?.from.email, MAILBOX);
    assert.equal(loaded.messages[0]?.isOutgoing, true);
    assert.equal(loaded.messages.at(-1)?.from.email, OUTSIDER);
    assert.equal(loaded.messages.at(-1)?.isOutgoing, false);

    const queued = await conversationsNeedingRead(accountId, 50);
    assert.ok(
      queued.some((queuedId) => queuedId === id),
      "the inbox reply is eligible for the read cron",
    );

    const before = await db.pool.query<{ n: number }>(
      "select count(*)::int as n from seer.matters where account_id = $1",
      [accountId],
    );
    const read = await readStored(
      id,
      loaded,
      matterProposal("Vendor Q3 figures", "Send comments on the Q3 figures"),
    );

    const view = await buildInboxView(accountId, "google");
    assert.equal(
      view.atlas.some((card) => card.title === "Vendor Q3 figures"),
      false,
      `atlas titles: ${view.atlas.map((card) => card.title).join(" | ")}`,
    );
    assert.equal(read.decisionHome, "record");
    assert.ok(read.veto.includes("matter_untrusted_sender"), read.veto.join(","));
    assert.ok(read.veto.includes("prior_triage_rejection"), read.veto.join(","));
    assert.equal(read.matterId, null);
    assert.equal(read.seen.routingFacts.senderIsInternal, false);
    assert.equal(read.seen.routingFacts.senderIsKnown, false);
    assert.match(read.seen.contextText, new RegExp(`sender ${OUTSIDER}`));
    assert.doesNotMatch(read.seen.contextText, /inside your organization/);
    assert.doesNotMatch(read.seen.contextText, new RegExp(`sender ${MAILBOX}`));
    assert.match(read.seen.contextText, /archive\/delete/);

    const after = await db.pool.query<{ n: number }>(
      "select count(*)::int as n from seer.matters where account_id = $1",
      [accountId],
    );
    assert.equal(after.rows[0].n, before.rows[0].n, "a rejected reply must not create an Atlas matter");
    const linked = await db.pool.query(
      "select 1 from seer.matter_conversations where conversation_id = $1",
      [id],
    );
    assert.equal(linked.rowCount, 0);
  });

  await check("shadow path: same reply loaded with the rest of the mailbox", async () => {
    const convo = thread("shadow-reply", "Packing list", [
      userNote("shadow-user", "2026-08-03T09:00:00Z", "Please send the packing list."),
      outsiderReply("shadow-reply-msg", "Packing list reply", "2026-08-03T15:00:00Z"),
    ]);
    const { id } = await storedThread(convo);
    const all = await loadStoredConversations(accountId);
    const found = all.find((item) => item.conversationId === id);
    assert.ok(found);
    assert.equal(found!.conversation.messages[0]?.from.email, MAILBOX);
    assert.equal(found!.conversation.messages.at(-1)?.from.email, OUTSIDER);

    const read = await readStored(
      id,
      found!.conversation,
      matterProposal("Vendor packing list", "Send comments on the packing list"),
    );
    assert.equal(read.decisionHome, "record");
    assert.ok(read.veto.includes("matter_untrusted_sender"), read.veto.join(","));
    assert.equal(read.matterId, null);
    assert.equal(read.seen.routingFacts.senderIsInternal, false);
    assert.equal(read.seen.routingFacts.senderIsKnown, false);
    assert.match(read.seen.contextText, new RegExp(`sender ${OUTSIDER}`));
    assert.doesNotMatch(read.seen.contextText, /inside your organization/);
  });

  await check("mailbox follow-up does not hide the outsider reply", async () => {
    const convo = thread("follow-up", "Q4 plan", [
      userNote("follow-user-1", "2026-08-04T09:00:00Z", "Can you send the Q4 plan?"),
      outsiderReply("follow-reply", "Q4 plan reply", "2026-08-04T15:00:00Z"),
      userNote("follow-user-2", "2026-08-05T09:00:00Z", "Checking that you saw the request above."),
    ]);
    const { id, loaded } = await storedThread(convo);
    assert.deepEqual(
      loaded.messages.map((item) => item.from.email),
      [MAILBOX, OUTSIDER, MAILBOX],
    );
    const read = await readStored(
      id,
      loaded,
      matterProposal("Vendor Q4 plan", "Send the Q4 plan"),
    );
    assert.equal(read.decisionHome, "record");
    assert.ok(read.veto.includes("matter_untrusted_sender"), read.veto.join(","));
    assert.equal(read.matterId, null);
    assert.equal(read.seen.routingFacts.senderIsInternal, false);
    assert.equal(read.seen.routingFacts.senderIsKnown, false);
    assert.match(read.seen.contextText, new RegExp(`sender ${OUTSIDER}`));
    assert.doesNotMatch(read.seen.contextText, /inside your organization/);
  });

  await check("only the mailbox's own sent mail is not an internal sender", async () => {
    const convo = thread("sent-only", "Intro", [
      userNote("sent-only-1", "2026-08-06T09:00:00Z", "Hello, sharing the intro note."),
    ]);
    const { id, loaded } = await storedThread(convo);
    assert.equal(loaded.messages.length, 1);
    assert.equal(loaded.messages[0]?.from.email, MAILBOX);
    const read = await readStored(
      id,
      loaded,
      matterProposal("Intro outreach", "Reply to the intro"),
    );
    assert.equal(read.decisionHome, "record");
    assert.ok(read.veto.includes("matter_untrusted_sender"), read.veto.join(","));
    assert.equal(read.matterId, null);
    assert.equal(read.seen.routingFacts.senderIsInternal, false);
    assert.equal(read.seen.routingFacts.senderIsKnown, false);
    assert.doesNotMatch(read.seen.contextText, /inside your organization/);
    assert.doesNotMatch(read.seen.contextText, /tier=inner/);
  });

  await check("a colleague reply stays internal without using the mailbox identity", async () => {
    const convo = thread("colleague-reply", "Budget draft", [
      message({
        id: "colleague-user",
        from: MAILBOX,
        to: COLLEAGUE,
        sentAt: "2026-08-07T09:00:00Z",
        body: "Can you send the budget draft?",
      }),
      message({
        id: "colleague-reply-msg",
        from: COLLEAGUE,
        to: MAILBOX,
        sentAt: "2026-08-07T15:00:00Z",
        body: "The budget draft is ready. Please send the signed copy back.",
      }),
    ]);
    const { id, loaded } = await storedThread(convo);
    const read = await readStored(
      id,
      loaded,
      matterProposal("Budget draft review", "Send the signed budget draft"),
    );
    assert.equal(read.seen.routingFacts.senderIsInternal, true);
    assert.equal(read.seen.routingFacts.senderIsKnown, false);
    assert.match(read.seen.contextText, new RegExp(`sender ${COLLEAGUE}`));
    assert.match(read.seen.contextText, /inside your organization/);
    assert.doesNotMatch(read.seen.contextText, new RegExp(`sender ${MAILBOX}`));
    assert.equal(read.decisionHome, "matter");
    assert.ok(read.matterId);
  });

  await check("a known outsider is that contact, not the mailbox VIP", async () => {
    const convo = thread("known-reply", "SOW pricing", [
      message({
        id: "known-user",
        from: MAILBOX,
        to: KNOWN,
        sentAt: "2026-08-08T09:00:00Z",
        body: "Can you confirm the SOW pricing?",
      }),
      message({
        id: "known-reply-msg",
        from: KNOWN,
        to: MAILBOX,
        sentAt: "2026-08-08T15:00:00Z",
        body: "Pricing is attached. Please confirm the SOW total.",
      }),
    ]);
    const { id, loaded } = await storedThread(convo);
    const read = await readStored(
      id,
      loaded,
      matterProposal("Partner SOW pricing", "Confirm the SOW total"),
    );
    assert.equal(read.seen.routingFacts.senderIsKnown, true);
    assert.equal(read.seen.routingFacts.senderIsInternal, false);
    assert.match(read.seen.contextText, new RegExp(`sender ${KNOWN} is tier=known`));
    assert.doesNotMatch(read.seen.contextText, /inside your organization/);
    assert.doesNotMatch(read.seen.contextText, /\(VIP\)/);
    assert.equal(read.decisionHome, "matter");
    assert.ok(read.matterId);
  });

  await check("delete safety uses the replier, not the mailbox", async () => {
    const convo = thread("delete-reply", "Weekly links", [
      userNote("delete-user", "2026-08-09T09:00:00Z", "Send me anything worth a look."),
      message({
        id: "delete-reply-msg",
        from: OUTSIDER,
        to: MAILBOX,
        sentAt: "2026-08-09T15:00:00Z",
        body: "A stack of unrelated links with nothing to do.",
      }),
    ]);
    const { id, loaded } = await storedThread(convo);
    const read = await readStored(id, loaded, {
      home: "delete",
      summary: "Unrelated links",
      rationale: "no work here",
      owner: "nobody",
      ask: "nothing — informational",
      obligation: false,
      yields: [],
      evidence: [],
    });
    assert.equal(read.decisionHome, "delete");
    assert.ok(!read.veto.includes("internal_sender"), read.veto.join(","));
    assert.ok(!read.veto.includes("known_sender"), read.veto.join(","));
    assert.equal(read.seen.routingFacts.senderIsInternal, false);
    assert.equal(read.seen.routingFacts.senderIsKnown, false);
  });

  await check("salience does not inherit the mailbox VIP tier", async () => {
    const convo = thread("salience-reply", "Status", [
      userNote("salience-user", "2026-08-10T09:00:00Z", "Send a status when you can."),
      outsiderReply("salience-reply-msg", "Status reply", "2026-08-10T15:00:00Z"),
    ]);
    const { id, loaded } = await storedThread(convo);
    const read = await readStored(id, loaded, {
      home: "record",
      summary: "Status note",
      rationale: "keep",
      owner: "you",
      ask: "Send comments on the status",
      obligation: false,
      yields: [],
      evidence: [],
    });
    // Direct address plus the user owing a reply is 2. The mailbox VIP flag
    // must not add the senior-sender point.
    assert.equal(read.priority, 2);
    assert.equal(read.seen.routingFacts.senderIsKnown, false);
  });

  await check("a thread the outsider started is still untrusted", async () => {
    const convo = thread("outsider-first", "Cold note", [
      outsiderReply("outsider-first-msg", "Cold note body", "2026-08-11T15:00:00Z"),
    ]);
    const { id, loaded } = await storedThread(convo);
    const read = await readStored(
      id,
      loaded,
      matterProposal("Cold vendor note", "Send comments on the cold note"),
    );
    assert.equal(read.seen.routingFacts.senderIsInternal, false);
    assert.equal(read.seen.routingFacts.senderIsKnown, false);
    assert.equal(read.decisionHome, "record");
    assert.ok(read.veto.includes("matter_untrusted_sender"));
    assert.equal(read.matterId, null);
  });
} finally {
  await db.stop();
}

if (failures.length > 0) {
  console.error(`v2-sender-identity: ${failures.length} case(s) failed`);
  for (const failure of failures) console.error(`\n${failure}`);
  process.exit(1);
}

console.log("v2-sender-identity: OK");
