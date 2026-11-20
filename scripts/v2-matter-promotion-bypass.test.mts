/**
 * An outsider who can deliver mail must not land that mail on a matter the
 * user named, and must not be promoted to live work, merely because the
 * subject normalizes to the matter title.
 *
 * The model is the injected reader the pipeline already uses. These cases
 * hand it a `matter` label that the promotion gate is required to reject
 * when the sender is not already on the matter. They fail while a normalized
 * subject match is treated as continuity.
 */
import assert from "node:assert/strict";
import { GmailProvider } from "../src/lib/v2/providers/gmail.ts";
import { writeConversationPage } from "../src/lib/v2/sync/repository.ts";
import { upsertUser, upsertAccount } from "../src/lib/v2/db/accounts.ts";
import { asConversationId, type AccountId } from "../src/lib/v2/db/types.ts";
import { placeConversationOnMatter } from "../src/lib/v2/intelligence/user-matter.ts";
import {
  clearContextInputCache,
  loadContextInput,
} from "../src/lib/v2/intelligence/context-loader.ts";
import { loadConversation } from "../src/lib/v2/intelligence/load-conversation.ts";
import {
  readConversation,
  type ReaderModel,
} from "../src/lib/v2/intelligence/reader.ts";
import type { ReadResult } from "../src/lib/v2/intelligence/schema.ts";
import { startTestDb } from "./v2-testdb.mts";

const USER_EMAIL = "executive@rditrials.com";
const USER_TITLE = "Harbour lease renewal";
/** Case and punctuation differ; the matcher compares normalized titles. */
const ATTACK_SUBJECT = "HARBOUR: lease renewal!";
const OUTSIDER = "stranger@gmail.com";

function b64url(value: string): string {
  return Buffer.from(value, "utf8").toString("base64url");
}

function gmailThread(input: {
  id: string;
  subject: string;
  from: string;
  to: string;
  body: string;
}) {
  return {
    id: input.id,
    messages: [
      {
        id: `${input.id}-m1`,
        threadId: input.id,
        snippet: input.body.slice(0, 80),
        labelIds: ["INBOX", "UNREAD"],
        internalDate: "1750000000000",
        payload: {
          headers: [
            { name: "From", value: `Outsider <${input.from}>` },
            { name: "To", value: input.to },
            { name: "Subject", value: input.subject },
          ],
          mimeType: "text/plain",
          body: { data: b64url(input.body) },
        },
      },
    ],
  };
}

function gmailFetch(
  threads: ReturnType<typeof gmailThread>[],
): typeof fetch {
  const byId = new Map(threads.map((thread) => [thread.id, thread]));
  return (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("/threads?") && url.includes("q=in%3Ainbox")) {
      return Response.json({
        threads: threads.map((thread) => ({ id: thread.id })),
        resultSizeEstimate: threads.length,
      });
    }
    const threadId = url.match(/\/threads\/([^?]+)/)?.[1];
    const thread = threadId ? byId.get(decodeURIComponent(threadId)) : undefined;
    if (thread && url.includes("format=full")) return Response.json(thread);
    throw new Error(`unexpected Gmail request: ${url}`);
  }) as typeof fetch;
}

const WEAK_BODY =
  "Distribution list status. The portal refreshed overnight. No reply is needed.";
const DIRECT_BODY =
  "Hi executive, please confirm the harbour lease renewal by Friday.";

function matterRead(overrides: Partial<ReadResult> = {}): ReadResult {
  return {
    home: "matter",
    summary: "Inbound note",
    rationale: "model labelled this live work",
    owner: "nobody",
    ask: "nothing — informational",
    obligation: false,
    yields: [],
    evidence: [],
    ...overrides,
  };
}

const modelFor =
  (result: ReadResult): ReaderModel =>
  async () =>
    result;

async function matterCount(
  pool: import("pg").Pool,
  accountId: AccountId,
): Promise<number> {
  const result = await pool.query<{ n: number }>(
    "select count(*)::int as n from seer.matters where account_id = $1",
    [accountId],
  );
  return result.rows[0].n;
}

async function linkedMatterIds(
  pool: import("pg").Pool,
  conversationId: string,
): Promise<string[]> {
  const result = await pool.query<{ matter_id: string }>(
    "select matter_id from seer.matter_conversations where conversation_id = $1",
    [conversationId],
  );
  return result.rows.map((row) => row.matter_id);
}

const db = await startTestDb();
const failures: string[] = [];

function expect(condition: boolean, message: string): void {
  if (!condition) failures.push(message);
}

try {
  const userId = await upsertUser(USER_EMAIL);
  const accountId = await upsertAccount({
    userId,
    provider: "google",
    email: USER_EMAIL,
  });

  const seed = await db.pool.query<{ id: string }>(
    `insert into seer.conversations
       (account_id, provider_conversation_id, subject)
     values ($1, 'user-named-seed', 'Desk note')
     returning id`,
    [accountId],
  );
  const named = await placeConversationOnMatter(
    accountId,
    asConversationId(seed.rows[0].id),
    { createNew: true, matterTitle: USER_TITLE },
  );
  const userMatterId = named.matterId;
  const mattersBefore = await matterCount(db.pool, accountId);
  assert.equal(mattersBefore, 1);

  const threads = [
    gmailThread({
      id: "attack-weak",
      subject: ATTACK_SUBJECT,
      from: OUTSIDER,
      to: "vendors@example.net",
      body: WEAK_BODY,
    }),
    gmailThread({
      id: "attack-renamed",
      subject: ATTACK_SUBJECT,
      from: OUTSIDER,
      to: "vendors@example.net",
      body: WEAK_BODY,
    }),
    gmailThread({
      id: "attack-direct",
      subject: ATTACK_SUBJECT,
      from: OUTSIDER,
      to: USER_EMAIL,
      body: DIRECT_BODY,
    }),
    gmailThread({
      id: "unrelated-weak",
      subject: "Office chair catalog",
      from: OUTSIDER,
      to: "vendors@example.net",
      body: WEAK_BODY,
    }),
  ];
  const provider = new GmailProvider({
    accessToken: "test-token",
    accountEmail: USER_EMAIL,
    fetchImpl: gmailFetch(threads),
  });
  const page = await provider.sync();
  const stored = await writeConversationPage(
    accountId,
    "inbox",
    page.conversations,
    [],
  );
  assert.equal(stored.stored, threads.length);
  assert.equal(stored.failed, 0);

  clearContextInputCache();
  const context = await loadContextInput(accountId, USER_EMAIL);
  const loadedMatter = context.matters.find((matter) => matter.id === userMatterId);
  assert.equal(loadedMatter?.userAuthored, true);
  assert.equal(loadedMatter?.title, USER_TITLE);

  async function readStored(providerId: string, read: ReadResult) {
    const row = await db.pool.query<{ id: string }>(
      `select id from seer.conversations
        where account_id = $1 and provider_conversation_id = $2`,
      [accountId, providerId],
    );
    const conversationId = asConversationId(row.rows[0].id);
    const conversation = await loadConversation(conversationId);
    assert.ok(conversation, `${providerId} must load`);
    const decision = await readConversation({
      accountId,
      conversationId,
      conversation: conversation!,
      context,
      model: modelFor(read),
    });
    return { conversationId, conversation: conversation!, decision };
  }

  // Subject from the Gmail header survived sync and is the oldest message.
  {
    const row = await db.pool.query<{ id: string }>(
      `select id from seer.conversations
        where account_id = $1 and provider_conversation_id = 'attack-weak'`,
      [accountId],
    );
    const loaded = await loadConversation(row.rows[0].id);
    assert.equal(loaded?.subject, ATTACK_SUBJECT);
    assert.equal(loaded?.messages.length, 1);
    assert.equal(loaded?.messages[0]?.from.email, OUTSIDER);
    assert.equal(loaded?.messages[0]?.isOutgoing, false);
  }

  // The model does not repeat the title. The subject is the only name, and
  // the sender fails every promotion check.
  {
    const before = await matterCount(db.pool, accountId);
    const { conversationId, decision } = await readStored(
      "attack-weak",
      matterRead(),
    );
    const links = await linkedMatterIds(db.pool, conversationId);
    expect(
      decision.home === "record",
      `weak subject match promoted to ${decision.home} (vetoes: ${decision.vetoReasons.join(",") || "none"})`,
    );
    expect(
      decision.vetoReasons.includes("matter_not_direct") &&
        decision.vetoReasons.includes("matter_no_open_work") &&
        decision.vetoReasons.includes("matter_untrusted_sender") &&
        decision.vetoReasons.includes("matter_owner_nobody") &&
        decision.vetoReasons.includes("matter_ref_missing"),
      `weak subject match skipped promotion checks (vetoes: ${decision.vetoReasons.join(",") || "none"})`,
    );
    expect(
      !links.includes(userMatterId) && decision.matterId !== userMatterId,
      `weak subject match attached mail to the user matter ${userMatterId}`,
    );
    expect(
      (await matterCount(db.pool, accountId)) === before,
      "weak subject match created a matter before promotion was refused",
    );
  }

  // A different model name must not become a new live matter either.
  {
    const before = await matterCount(db.pool, accountId);
    const { conversationId, decision } = await readStored(
      "attack-renamed",
      matterRead({ matterRef: "Vendor portal refresh notice" }),
    );
    const links = await linkedMatterIds(db.pool, conversationId);
    expect(
      decision.home === "record",
      `renamed subject match promoted to ${decision.home} (matter ${decision.matterId ?? "none"})`,
    );
    expect(
      decision.vetoReasons.includes("matter_not_direct") &&
        decision.vetoReasons.includes("matter_no_open_work") &&
        decision.vetoReasons.includes("matter_untrusted_sender"),
      `renamed subject match skipped promotion checks (vetoes: ${decision.vetoReasons.join(",") || "none"})`,
    );
    expect(
      !links.includes(userMatterId),
      "renamed subject match attached mail to the user matter",
    );
    expect(
      (await matterCount(db.pool, accountId)) === before,
      "renamed subject match created a live matter before promotion was refused",
    );
  }

  // A real ask still must not join the matter the user named. The sender
  // has never been on it. Re-resolving the title at link time is the same bug.
  {
    const { conversationId, decision } = await readStored(
      "attack-direct",
      matterRead({
        owner: "you",
        ask: "Confirm the harbour lease renewal",
        matterRef: USER_TITLE,
      }),
    );
    const links = await linkedMatterIds(db.pool, conversationId);
    expect(
      !links.includes(userMatterId) && decision.matterId !== userMatterId,
      `direct subject match joined user matter ${userMatterId} as ${decision.matterId ?? "unlinked"} (home ${decision.home})`,
    );
  }

  // A subject that does not match the user title stays off the board.
  {
    const before = await matterCount(db.pool, accountId);
    const { conversationId, decision } = await readStored(
      "unrelated-weak",
      matterRead(),
    );
    const links = await linkedMatterIds(db.pool, conversationId);
    assert.equal(decision.home, "record");
    assert.ok(decision.vetoReasons.includes("matter_untrusted_sender"));
    assert.ok(!links.includes(userMatterId));
    assert.equal(await matterCount(db.pool, accountId), before);
  }

  // The same subject against an inferred title is not continuity.
  {
    const otherUser = await upsertUser("other@rditrials.com");
    const otherAccount = await upsertAccount({
      userId: otherUser,
      provider: "google",
      email: "other@rditrials.com",
    });
    await db.pool.query(
      `insert into seer.matters (account_id, title, title_source)
       values ($1, $2, 'inferred')`,
      [otherAccount, USER_TITLE],
    );
    const inferredThreads = [
      gmailThread({
        id: "inferred-weak",
        subject: ATTACK_SUBJECT,
        from: OUTSIDER,
        to: "vendors@example.net",
        body: WEAK_BODY,
      }),
    ];
    const inferredProvider = new GmailProvider({
      accessToken: "test-token",
      accountEmail: "other@rditrials.com",
      fetchImpl: gmailFetch(inferredThreads),
    });
    const inferredPage = await inferredProvider.sync();
    await writeConversationPage(
      otherAccount,
      "inbox",
      inferredPage.conversations,
      [],
    );
    clearContextInputCache();
    const inferredContext = await loadContextInput(
      otherAccount,
      "other@rditrials.com",
    );
    assert.equal(inferredContext.matters[0]?.userAuthored, false);
    const before = await matterCount(db.pool, otherAccount);
    const row = await db.pool.query<{ id: string }>(
      `select id from seer.conversations
        where account_id = $1 and provider_conversation_id = 'inferred-weak'`,
      [otherAccount],
    );
    const conversationId = asConversationId(row.rows[0].id);
    const conversation = await loadConversation(conversationId);
    const decision = await readConversation({
      accountId: otherAccount,
      conversationId,
      conversation: conversation!,
      context: inferredContext,
      model: modelFor(matterRead()),
    });
    assert.equal(decision.home, "record");
    assert.equal(await matterCount(db.pool, otherAccount), before);
    assert.deepEqual(await linkedMatterIds(db.pool, conversationId), []);
  }

  assert.deepEqual(failures, [], failures.join("\n"));
} finally {
  await db.stop();
}
