/**
 * Unconfirmed mailbox style must not govern triage, relevance, or the
 * chief-of-staff reader.
 *
 * Delivered mail is synced through the real folder sync engine. A large
 * provider inbox makes inferStyle choose leave-in-inbox, an unread cue, and
 * a high matter bar. Refreshing mailbox style (what GET /api/v2/mailbox-style
 * does for the signed-in account) may store that hypothesis, but until the
 * user confirms it the columns and readers that dispose of mail must keep
 * the archive default, and the read context must not call the hypothesis
 * explicit user guidance.
 *
 * These assertions fail while that unconfirmed hypothesis is applied.
 */
import assert from "node:assert/strict";
import { upsertAccount, upsertUser } from "../src/lib/v2/db/accounts.ts";
import { asConversationId, type AccountId } from "../src/lib/v2/db/types.ts";
import { executeCommand } from "../src/lib/v2/commands/execute.ts";
import { compileContext } from "../src/lib/v2/intelligence/context.ts";
import {
  clearContextInputCache,
  loadContextInput,
} from "../src/lib/v2/intelligence/context-loader.ts";
import { loadConversation } from "../src/lib/v2/intelligence/load-conversation.ts";
import { CHIEF_OF_STAFF_SYSTEM } from "../src/lib/v2/intelligence/model.ts";
import {
  confirmMailboxStyle,
  effectiveStyle,
  guidanceFor,
  loadMailboxStyle,
  refreshMailboxInference,
} from "../src/lib/v2/intelligence/mailbox-style-store.ts";
import type { StyleInference } from "../src/lib/v2/intelligence/mailbox-style.ts";
import { readConversation, type ReaderModel } from "../src/lib/v2/intelligence/reader.ts";
import { FakeProvider } from "../src/lib/v2/providers/fake.ts";
import type { SyncFolder } from "../src/lib/v2/providers/types.ts";
import { syncFolder } from "../src/lib/v2/sync/engine.ts";
import { startTestDb, type TestDb } from "./v2-testdb.mts";

const failures: string[] = [];

async function check(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
  } catch (error) {
    failures.push(
      `${name}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function deliveredInbox(count: number, pageSize: number): FakeProvider {
  return new FakeProvider({
    pageSize,
    conversations: Array.from({ length: count }, (_, index) => ({
      providerConversationId: `delivered-${index}`,
      subject: `Delivered ${index}`,
      messages: [
        {
          providerMessageId: `delivered-msg-${index}`,
          from: { email: "sender@outside.example", name: "Outside Sender" },
          to: [{ email: "desk@rditrials.com" }],
          cc: [],
          sentAt: "2026-08-01T12:00:00.000Z",
          snippet: "A note that arrived in the inbox.",
          bodyHtml: "<p>A note that arrived in the inbox.</p>",
          bodyText: "A note that arrived in the inbox.",
          isUnread: true,
          isOutgoing: false,
          attachments: [],
          folder: "inbox" satisfies SyncFolder,
        },
      ],
    })),
  });
}

async function openAccount(email: string): Promise<AccountId> {
  const userId = await upsertUser(email);
  return upsertAccount({
    userId,
    provider: "google",
    email,
  });
}

/** One product sync page, the same bound wake uses, so provider_total is the whole inbox. */
async function syncDeliveredInbox(
  accountId: AccountId,
  count: number,
): Promise<void> {
  const provider = deliveredInbox(count, 25);
  await syncFolder(accountId, provider, "inbox", "incremental", {
    maxPages: 1,
  });
}

type StyleRow = {
  clear_habit: string;
  importance_cues: string[];
  matter_bar: string;
  confirmed: boolean;
  inferred: StyleInference;
};

async function styleRow(db: TestDb, accountId: AccountId): Promise<StyleRow> {
  const result = await db.pool.query<StyleRow>(
    `select clear_habit, importance_cues, matter_bar, confirmed, inferred
       from seer.mailbox_styles where account_id = $1`,
    [accountId],
  );
  const row = result.rows[0];
  if (!row) throw new Error("mailbox style row missing");
  return row;
}

async function conversationIds(
  db: TestDb,
  accountId: AccountId,
  limit: number,
): Promise<string[]> {
  const result = await db.pool.query<{ id: string }>(
    `select id from seer.conversations
      where account_id = $1
      order by provider_conversation_id
      limit $2`,
    [accountId, limit],
  );
  return result.rows.map((row) => row.id);
}

async function focusHidden(
  db: TestDb,
  conversationId: string,
): Promise<boolean> {
  const result = await db.pool.query<{ focus_hidden: boolean }>(
    "select focus_hidden from seer.conversations where id = $1",
    [conversationId],
  );
  return result.rows[0]?.focus_hidden === true;
}

async function outboxType(
  db: TestDb,
  accountId: AccountId,
  conversationId: string,
): Promise<string | null> {
  const result = await db.pool.query<{ command: { type?: string } }>(
    `select command from seer.outbox
      where account_id = $1 and command->>'conversationId' = $2`,
    [accountId, conversationId],
  );
  return result.rows[0]?.command.type ?? null;
}

/**
 * Readers must keep the archive default while the stored style is unconfirmed,
 * even if the active columns already hold a leave / unread / high hypothesis.
 */
async function assertReadersStayOnArchiveDefault(
  db: TestDb,
  accountId: AccountId,
  triageId: string,
  relevanceId: string,
  label: string,
): Promise<void> {
  await check(`${label} effective style`, async () => {
    const stored = await loadMailboxStyle(accountId);
    assert.equal(stored?.confirmed, false);
    assert.deepEqual(effectiveStyle(stored), {
      clearHabit: "archive",
      importanceCues: ["none"],
      matterBar: "medium",
    });
    const guidance = guidanceFor(stored);
    assert.doesNotMatch(guidance, /leave mail in the Inbox/);
    assert.doesNotMatch(guidance, /mark importance with unread/);
    assert.doesNotMatch(guidance, /only real ongoing work/);
  });

  await check(`${label} triage`, async () => {
    const triaged = await executeCommand(
      { accountId },
      {
        type: "triageConversation",
        conversationId: triageId,
        destination: "archive",
      },
      `${label}-triage`,
    );
    assert.equal(triaged.ok, true);
    assert.deepEqual(
      {
        providerAction: await outboxType(db, accountId, triageId),
        focusHidden: await focusHidden(db, triageId),
      },
      { providerAction: "archive", focusHidden: false },
    );
  });

  await check(`${label} relevance`, async () => {
    const trained = await executeCommand(
      { accountId },
      {
        type: "trainRelevance",
        conversationId: relevanceId,
        relevant: false,
        reason: "taken_care_of",
      },
      `${label}-relevance`,
    );
    assert.equal(trained.ok, true);
    assert.equal(await outboxType(db, accountId, relevanceId), "archive");
  });

  await check(`${label} reader`, async () => {
    clearContextInputCache();
    const context = await loadContextInput(accountId, "desk@rditrials.com");
    const loaded = await loadConversation(triageId);
    if (!loaded) throw new Error("conversation missing");
    const compiled = compileContext(loaded, context);
    assert.equal(
      compiled.text.includes("[explicit] how this person uses mail (user)"),
      false,
      `unconfirmed style was labeled as the user's guidance:\n${compiled.text}`,
    );
    assert.equal(context.mailboxStyleGuidance ?? "", "");

    let modelContext = "";
    const model: ReaderModel = async (input) => {
      modelContext = input.contextText;
      return {
        home: "record",
        summary: "Kept as a record.",
        rationale: "No live ask.",
        owner: "nobody",
        ask: "nothing — informational",
        obligation: false,
        yields: [],
        evidence: [],
      };
    };
    await readConversation({
      accountId,
      conversationId: asConversationId(triageId),
      conversation: loaded,
      context,
      model,
    });
    assert.equal(modelContext, compiled.text);
    assert.doesNotMatch(modelContext, /\[explicit\] how this person uses mail/);
    assert.match(
      CHIEF_OF_STAFF_SYSTEM,
      /\[explicit\]\/\[system\] outrank your reading/,
    );
  });
}

const db = await startTestDb();
try {
  const largeId = await openAccount("large@rditrials.com");
  await syncDeliveredInbox(largeId, 2000);
  const largeRefreshed = await refreshMailboxInference(largeId);
  assert.equal(largeRefreshed.confirmed, false);
  assert.ok(
    largeRefreshed.snapshot.providerInboxTotal >= 2000,
    `provider inbox count ${largeRefreshed.snapshot.providerInboxTotal} did not follow the synced mailbox`,
  );
  assert.equal(largeRefreshed.snapshot.openMatters, 0);
  assert.equal(largeRefreshed.inferred.clearHabit, "leave");
  assert.equal(largeRefreshed.inferred.matterBar, "high");
  assert.ok(largeRefreshed.inferred.importanceCues.includes("unread"));

  const [largeTriage, largeRelevance] = await conversationIds(db, largeId, 2);
  await check("synced inbox of 2000 keeps the hypothesis off the active columns", async () => {
    const row = await styleRow(db, largeId);
    assert.equal(row.confirmed, false);
    assert.equal(row.clear_habit, "archive");
    assert.deepEqual(row.importance_cues, ["none"]);
    assert.equal(row.matter_bar, "medium");
    assert.equal(row.inferred.clearHabit, "leave");
    assert.equal(row.inferred.matterBar, "high");
    assert.ok(row.inferred.importanceCues.includes("unread"));
  });
  await check("synced inbox of 2000 does not govern readers", async () => {
    await assertReadersStayOnArchiveDefault(
      db,
      largeId,
      largeTriage,
      largeRelevance,
      "inbox-2000",
    );
  });

  const wideId = await openAccount("wide@rditrials.com");
  await syncDeliveredInbox(wideId, 401);
  const wideRefreshed = await refreshMailboxInference(wideId);
  assert.equal(wideRefreshed.confirmed, false);
  assert.ok(wideRefreshed.snapshot.providerInboxTotal > 400);
  assert.equal(
    wideRefreshed.snapshot.recentUserArchives +
      wideRefreshed.snapshot.recentUserDeletes,
    0,
  );
  assert.equal(wideRefreshed.inferred.clearHabit, "leave");

  const [wideTriage, wideRelevance] = await conversationIds(db, wideId, 2);
  await check(
    "synced inbox above 400 with no recent clears keeps the hypothesis off the active columns",
    async () => {
      const row = await styleRow(db, wideId);
      assert.equal(row.clear_habit, "archive");
      assert.deepEqual(row.importance_cues, ["none"]);
      assert.equal(row.matter_bar, "medium");
      assert.equal(row.inferred.clearHabit, "leave");
    },
  );
  await check(
    "synced inbox above 400 with no recent clears does not govern readers",
    async () => {
      await assertReadersStayOnArchiveDefault(
        db,
        wideId,
        wideTriage,
        wideRelevance,
        "inbox-401",
      );
    },
  );

  const storedId = await openAccount("stored@rditrials.com");
  await syncDeliveredInbox(storedId, 30);
  const [storedTriage, storedRelevance] = await conversationIds(db, storedId, 2);
  await db.pool.query(
    `insert into seer.mailbox_styles
       (account_id, clear_habit, importance_cues, matter_bar, confirmed, inferred)
     values ($1, 'leave', array['unread']::text[], 'high', false, $2::jsonb)`,
    [
      storedId,
      JSON.stringify({
        clearHabit: "leave",
        importanceCues: ["unread"],
        matterBar: "high",
        confidence: 0.9,
        reasons: ["stored hypothesis"],
      }),
    ],
  );
  await check(
    "unconfirmed row already holding leave, unread, and a high matter bar",
    async () => {
      await assertReadersStayOnArchiveDefault(
        db,
        storedId,
        storedTriage,
        storedRelevance,
        "stored-unconfirmed",
      );
    },
  );

  await check(
    "unconfirmed delete habit does not trash a thread marked never relevant",
    async () => {
      const deleteId = await openAccount("delete-habit@rditrials.com");
      const inserted = await db.pool.query<{ id: string }>(
        `insert into seer.conversations
           (account_id, provider_conversation_id, subject, folders, is_unread)
         values ($1, 'delete-habit-thread', 'Delete habit', array['inbox'], true)
         returning id`,
        [deleteId],
      );
      const conversationId = inserted.rows[0].id;
      await db.pool.query(
        `insert into seer.mailbox_styles
           (account_id, clear_habit, importance_cues, matter_bar, confirmed, inferred)
         values ($1, 'delete', array['none']::text[], 'medium', false, $2::jsonb)`,
        [
          deleteId,
          JSON.stringify({
            clearHabit: "delete",
            importanceCues: ["none"],
            matterBar: "medium",
            confidence: 0.72,
            reasons: ["stored delete hypothesis"],
          }),
        ],
      );
      const trained = await executeCommand(
        { accountId: deleteId },
        {
          type: "trainRelevance",
          conversationId,
          relevant: false,
          reason: "never_was",
        },
        "unconfirmed-delete",
      );
      assert.equal(trained.ok, true);
      assert.equal(await outboxType(db, deleteId, conversationId), "archive");
    },
  );

  await check("confirmed leave still hides Focus without a provider archive", async () => {
    const confirmedId = await openAccount("confirmed@rditrials.com");
    const inserted = await db.pool.query<{ id: string }>(
      `insert into seer.conversations
         (account_id, provider_conversation_id, subject, folders, is_unread)
       values ($1, 'confirmed-thread', 'Confirmed thread', array['inbox'], true)
       returning id`,
      [confirmedId],
    );
    const conversationId = inserted.rows[0].id;
    const confirmed = await confirmMailboxStyle(confirmedId, {
      clearHabit: "leave",
      importanceCues: ["unread"],
      matterBar: "high",
    });
    assert.equal(confirmed.confirmed, true);
    const triaged = await executeCommand(
      { accountId: confirmedId },
      {
        type: "triageConversation",
        conversationId,
        destination: "archive",
      },
      "confirmed-triage",
    );
    assert.equal(triaged.ok, true);
    assert.equal(triaged.outboxId, undefined);
    assert.equal(await focusHidden(db, conversationId), true);
    clearContextInputCache();
    const context = await loadContextInput(confirmedId, "confirmed@rditrials.com");
    assert.match(
      context.mailboxStyleGuidance ?? "",
      /leave mail in the Inbox/,
    );
    const compiled = compileContext(
      {
        providerConversationId: "confirmed-thread",
        subject: "Confirmed thread",
        lastMessageAt: "2026-08-01T12:00:00.000Z",
        messages: [
          {
            providerMessageId: "confirmed-msg",
            from: { email: "sender@outside.example" },
            to: [{ email: "confirmed@rditrials.com" }],
            cc: [],
            sentAt: "2026-08-01T12:00:00.000Z",
            snippet: "hello",
            bodyHtml: "<p>hello</p>",
            bodyText: "hello",
            isUnread: true,
            isOutgoing: false,
            attachments: [],
          },
        ],
      },
      context,
    );
    assert.match(compiled.text, /\[explicit\] how this person uses mail \(user\)/);
    assert.match(compiled.text, /only real ongoing work is an Atlas matter/);
  });

  if (failures.length > 0) {
    throw new Error(`unconfirmed mailbox style is still applied\n${failures.join("\n")}`);
  }
  console.log("v2-unconfirmed-mailbox-style: OK");
} finally {
  await db.stop();
}
