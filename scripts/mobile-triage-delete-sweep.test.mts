/**
 * Mobile triage Delete all must not trash a conversation whose decision
 * changed after the list was loaded, and it must not record that trash as the
 * user's correction.
 *
 * The list the button closes over is a snapshot. A later read (a reply that
 * moves the thread onto a matter, or a safety veto that turns a delete into a
 * record) is stored as a new current decision. Desktop sweep commands carry the
 * signed token and the command bus refuses a stale one. This file pins that
 * outcome for the mobile pile sweep and for every other caller that submits
 * the same untokened triage delete: the row Delete button, the selection
 * toolbar, a swipe (the row's onDelete), and the card deck's verdict.
 *
 * These assertions fail while that sweep trashes the live provider thread.
 * A downgrade archives the mailbox row and leaves the current decision in
 * place. Writing "Deleted by you" or "Archived by you" over that decision is
 * still a failure. The old decision row is left in the table with home
 * delete, so authorizing that row — or the token that names it — instead of
 * the current row still trashes and still fails.
 */
import assert from "node:assert/strict";
import type { Pool } from "pg";
import { startTestDb, type TestDb } from "./v2-testdb.mts";
import { upsertUser, upsertAccount } from "../src/lib/v2/db/accounts.ts";
import { saveDecision } from "../src/lib/v2/intelligence/repository.ts";
import { db as appDb } from "../src/lib/v2/db/pool.ts";
import { signDecisionToken } from "../src/lib/v2/view/token.ts";
import { executeCommand } from "../src/lib/v2/commands/execute.ts";
import { confirmMailboxStyle } from "../src/lib/v2/intelligence/mailbox-style-store.ts";
import { GmailProvider } from "../src/lib/v2/providers/gmail.ts";
import { OutlookProvider } from "../src/lib/v2/providers/outlook.ts";
import { drainOutbox } from "../src/lib/v3/outbox/drain.ts";
import { sweepCommands } from "../src/components/v2/triage-select.ts";
import { commandForVerdict } from "../src/components/v3/triage-deck.ts";
import { asConversationId, type AccountId, type ConversationId } from "../src/lib/v2/db/types.ts";
import type { Command } from "../src/lib/v2/commands/types.ts";
import type { Home } from "../src/lib/v2/db/types.ts";
import type { MailboxRow, MailboxView } from "../src/lib/v3/mailbox/types.ts";

type DecisionRow = {
  id: string;
  home: string;
  summary: string;
  model_version: string;
};

type ProviderLog = {
  trashed: string[];
  archived: string[];
  threadsRead: string[];
};

const gmailLog: ProviderLog = { trashed: [], archived: [], threadsRead: [] };
const outlookLog: ProviderLog = { trashed: [], archived: [], threadsRead: [] };

/** provider conversation id → message ids the live thread contains. */
const liveThreads = new Map<string, { originalId: string; replyId: string }>();

function rememberThread(providerId: string): { originalId: string; replyId: string } {
  const thread = {
    originalId: `${providerId}-original`,
    replyId: `${providerId}-reply-after-list`,
  };
  liveThreads.set(providerId, thread);
  return thread;
}

function jsonResponse(body: unknown, status = 200): Response {
  const text = status === 204 || body == null ? "" : JSON.stringify(body);
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    text: async () => text,
  } as unknown as Response;
}

function gmailThread(providerId: string) {
  const thread = liveThreads.get(providerId);
  if (!thread) throw new Error(`no live gmail thread for ${providerId}`);
  const message = (id: string) => ({
    id,
    threadId: providerId,
    labelIds: ["INBOX"],
    snippet: "",
    internalDate: "1700000000000",
    payload: { mimeType: "text/plain", body: { size: 1, data: "eA" } },
  });
  return {
    id: providerId,
    messages: [message(thread.originalId), message(thread.replyId)],
  };
}

function outlookMessages(providerId: string) {
  const thread = liveThreads.get(providerId);
  if (!thread) throw new Error(`no live outlook thread for ${providerId}`);
  const message = (id: string) => ({
    id,
    conversationId: providerId,
    subject: "thread",
    parentFolderId: "inbox",
    isRead: true,
    body: { contentType: "text", content: "body" },
  });
  return { value: [message(thread.originalId), message(thread.replyId)] };
}

const gmailFetch: typeof fetch = async (input, init) => {
  const url = String(input);
  const method = (init?.method ?? "GET").toUpperCase();
  const threadId = url.match(/\/threads\/([^/?]+)/)?.[1];
  if (method === "GET" && threadId) {
    gmailLog.threadsRead.push(threadId);
    return jsonResponse(gmailThread(decodeURIComponent(threadId)));
  }
  const trashed = url.match(/\/messages\/([^/]+)\/trash$/)?.[1];
  if (method === "POST" && trashed) {
    gmailLog.trashed.push(decodeURIComponent(trashed));
    return jsonResponse(null, 204);
  }
  const modified = url.match(/\/messages\/([^/]+)\/modify$/)?.[1];
  if (method === "POST" && modified) {
    gmailLog.archived.push(decodeURIComponent(modified));
    return jsonResponse({});
  }
  throw new Error(`unexpected gmail request ${method} ${url}`);
};

const outlookFetch: typeof fetch = async (input, init) => {
  const url = String(input);
  const method = (init?.method ?? "GET").toUpperCase();
  if (method === "GET" && url.includes("/messages?")) {
    const filter = decodeURIComponent(url);
    const providerId = filter.match(/conversationId eq '([^']+)'/)?.[1];
    if (!providerId) throw new Error(`outlook list missing conversation id: ${filter}`);
    outlookLog.threadsRead.push(providerId);
    return jsonResponse(outlookMessages(providerId));
  }
  const moved = url.match(/\/messages\/([^/]+)\/move$/)?.[1];
  if (method === "POST" && moved) {
    const body = JSON.parse(String(init?.body ?? "{}")) as { destinationId?: string };
    const id = decodeURIComponent(moved);
    if (body.destinationId === "deleteditems") outlookLog.trashed.push(id);
    else outlookLog.archived.push(id);
    return jsonResponse(null, 204);
  }
  throw new Error(`unexpected outlook request ${method} ${url}`);
};

const gmail = new GmailProvider({
  accessToken: "placeholder",
  accountEmail: "sweep@example.com",
  fetchImpl: gmailFetch,
});
const outlook = new OutlookProvider({
  accessToken: "placeholder",
  accountEmail: "sweep@example.com",
  fetchImpl: outlookFetch,
});

function markLogs(): { gmail: number; outlook: number; gmailRead: number; outlookRead: number } {
  return {
    gmail: gmailLog.trashed.length,
    outlook: outlookLog.trashed.length,
    gmailRead: gmailLog.threadsRead.length,
    outlookRead: outlookLog.threadsRead.length,
  };
}

function trashedSince(mark: ReturnType<typeof markLogs>): string[] {
  return [
    ...gmailLog.trashed.slice(mark.gmail),
    ...outlookLog.trashed.slice(mark.outlook),
  ];
}

const failures: string[] = [];

function check(name: string, fn: () => Promise<void> | void): Promise<void> {
  return Promise.resolve()
    .then(fn)
    .catch((cause: unknown) => {
      const message = cause instanceof Error ? cause.message : String(cause);
      failures.push(`${name}\n${message}`);
    });
}

async function addConversation(
  pool: Pool,
  accountId: AccountId,
  providerId: string,
): Promise<ConversationId> {
  const inserted = await pool.query<{ id: string }>(
    `insert into seer.conversations
       (account_id, provider_conversation_id, subject, folders, is_unread)
     values ($1, $2, 'Thread', $3::text[], false)
     returning id`,
    [accountId, providerId, ["inbox"]],
  );
  rememberThread(providerId);
  return asConversationId(inserted.rows[0].id);
}

async function decide(
  accountId: AccountId,
  conversationId: ConversationId,
  home: Home,
  tag: string,
  vetoReasons: string[] = [],
): Promise<{ id: string }> {
  return saveDecision({
    accountId,
    conversationId,
    home,
    proposedHome: home,
    summary: tag,
    rationale: tag,
    owner: "nobody",
    vetoReasons,
    yields: [],
    evidence: [],
    modelVersion: "reader-test",
    contextVersion: tag,
  });
}

async function liveDecision(conversationId: string): Promise<DecisionRow> {
  const row = await appDb().query<DecisionRow>(
    `select id, home, summary, model_version
       from seer.conversation_decisions
      where conversation_id = $1 and is_current`,
    [conversationId],
  );
  const decision = row.rows[0];
  if (!decision) throw new Error(`no current decision for ${conversationId}`);
  return decision;
}

async function foldersOf(pool: Pool, conversationId: string): Promise<string[]> {
  const row = await pool.query<{ folders: string[] }>(
    "select folders from seer.conversations where id = $1",
    [conversationId],
  );
  return row.rows[0]?.folders ?? [];
}

async function outboxTypes(
  pool: Pool,
  accountId: AccountId,
  conversationId: string,
): Promise<string[]> {
  const rows = await pool.query<{ command: { type?: string; conversationId?: string } }>(
    "select command from seer.outbox where account_id = $1",
    [accountId],
  );
  return rows.rows
    .filter((row) => row.command.conversationId === conversationId)
    .map((row) => row.command.type ?? "");
}

async function deleteCorrections(
  pool: Pool,
  accountId: AccountId,
  conversationId: string,
): Promise<number> {
  const rows = await pool.query<{ payload: { conversationId?: string; home?: string } }>(
    `select payload from seer.events
      where account_id = $1 and kind = 'user_correction'`,
    [accountId],
  );
  return rows.rows.filter(
    (row) => row.payload.conversationId === conversationId && row.payload.home === "delete",
  ).length;
}

type SweepExpect = {
  name: string;
  accountId: AccountId;
  conversationId: ConversationId;
  providerId: string;
  command: Command;
  provider: "gmail" | "outlook" | "none";
  /** Default habit enqueues archive. Leave habit must still not trash. */
  expectArchive: boolean;
  live: DecisionRow;
};

async function runSweep(db: TestDb, spec: SweepExpect): Promise<void> {
  const mark = markLogs();
  const ctx = {
    accountId: spec.accountId,
    provider: spec.provider === "outlook" ? outlook : gmail,
  };
  let thrown: unknown;
  try {
    await executeCommand(ctx, spec.command, spec.name);
  } catch (cause) {
    thrown = cause;
  }
  if (spec.provider !== "none") {
    await drainOutbox(spec.accountId, spec.provider === "outlook" ? outlook : gmail);
  }
  const decision = await liveDecision(spec.conversationId);
  const folders = await foldersOf(db.pool, spec.conversationId);
  const queued = await outboxTypes(db.pool, spec.accountId, spec.conversationId);
  const corrections = await deleteCorrections(db.pool, spec.accountId, spec.conversationId);
  const trashed = trashedSince(mark);
  const thread = liveThreads.get(spec.providerId);
  const problems: string[] = [];
  if (thrown) problems.push(`command threw: ${thrown instanceof Error ? thrown.message : String(thrown)}`);
  if (queued.includes("trash")) problems.push(`outbox queued trash (${queued.join(",")})`);
  if (folders.includes("trash")) problems.push(`corpus folders include trash (${folders.join(",")})`);
  if (corrections > 0) problems.push("recorded a user correction with home delete");
  if (decision.id !== spec.live.id) {
    problems.push(
      `current decision changed from ${spec.live.home} to ${decision.home} (${decision.summary})`,
    );
  }
  if (thread && trashed.some((id) => id === thread.originalId || id === thread.replyId)) {
    problems.push(`provider trashed live messages: ${trashed.join(",")}`);
  }
  if (spec.expectArchive) {
    if (!queued.includes("archive")) problems.push(`expected an archive outbox row, queued ${queued.join(",") || "nothing"}`);
    if (!folders.includes("archive")) problems.push(`expected archive folders, saw ${folders.join(",")}`);
  }
  if (problems.length > 0) {
    throw new Error(problems.join("; "));
  }
}

const db = await startTestDb();
try {
  const userId = await upsertUser("sweep@example.com");
  const accountId = await upsertAccount({
    userId,
    provider: "google",
    email: "sweep@example.com",
  });
  const leaveUser = await upsertUser("leave@example.com");
  const leaveAccount = await upsertAccount({
    userId: leaveUser,
    provider: "google",
    email: "leave@example.com",
  });
  await confirmMailboxStyle(leaveAccount, {
    clearHabit: "leave",
    importanceCues: ["none"],
    matterBar: "medium",
  });
  const otherUser = await upsertUser("other@example.com");
  const otherAccount = await upsertAccount({
    userId: otherUser,
    provider: "google",
    email: "other@example.com",
  });

  async function planted(
    owner: AccountId,
    providerId: string,
    firstHome: Home,
    liveHome: Home,
    tag: string,
    vetoReasons: string[] = [],
  ): Promise<{
    conversationId: ConversationId;
    providerId: string;
    staleToken: string;
    live: DecisionRow;
    thread: { originalId: string; replyId: string };
  }> {
    const conversationId = await addConversation(db.pool, owner, providerId);
    const original = await decide(owner, conversationId, firstHome, `${tag}-loaded`);
    const staleToken = signDecisionToken(original.id, conversationId);
    await decide(owner, conversationId, liveHome, `${tag}-live`, vetoReasons);
    const live = await liveDecision(conversationId);
    const thread = liveThreads.get(providerId);
    if (!thread) throw new Error("thread missing");
    return { conversationId, providerId, staleToken, live, thread };
  }

  // --- controls: the harness and the already-safe command must hold ---

  {
    // A conversation whose CURRENT decision is still the one the token names.
    // A cleared sweep may trash every message the provider returns, including
    // one that exists only on the live thread.
    const conversationId = await addConversation(db.pool, accountId, "gmail-cleared");
    const current = await decide(accountId, conversationId, "delete", "ctrl-gmail-current");
    const token = signDecisionToken(current.id, conversationId);
    const thread = liveThreads.get("gmail-cleared");
    if (!thread) throw new Error("missing control thread");
    const mark = markLogs();
    const result = await executeCommand(
      { accountId, provider: gmail },
      { type: "delete", conversationId, deleteToken: token },
      "ctrl-gmail-cleared",
    );
    assert.equal(result.ok, true);
    const report = await drainOutbox(accountId, gmail);
    assert.equal(report.done >= 1, true, "drain did not finish the cleared delete");
    const trashed = trashedSince(mark);
    assert.ok(trashed.includes(thread.originalId), "cleared delete did not trash the original message");
    assert.ok(
      trashed.includes(thread.replyId),
      "cleared delete did not trash the reply that exists only on the live thread",
    );
    assert.ok(gmailLog.threadsRead.includes("gmail-cleared"), "gmail drain did not load the live thread");
  }

  {
    const conversationId = await addConversation(db.pool, accountId, "outlook-cleared");
    const current = await decide(accountId, conversationId, "delete", "ctrl-outlook-current");
    const token = signDecisionToken(current.id, conversationId);
    const thread = liveThreads.get("outlook-cleared");
    if (!thread) throw new Error("missing outlook control thread");
    const mark = markLogs();
    const result = await executeCommand(
      { accountId, provider: outlook },
      { type: "delete", conversationId, deleteToken: token },
      "ctrl-outlook-cleared",
    );
    assert.equal(result.ok, true);
    await drainOutbox(accountId, outlook);
    const trashed = trashedSince(mark);
    assert.ok(trashed.includes(thread.originalId), "outlook cleared delete missed the original");
    assert.ok(trashed.includes(thread.replyId), "outlook cleared delete missed the later reply");
    assert.ok(
      outlookLog.threadsRead.includes("outlook-cleared"),
      "outlook drain did not load the live conversation",
    );
  }

  {
    // A person who picked this row and pressed Delete is not second-guessed.
    const conversationId = await addConversation(db.pool, accountId, "gmail-by-user");
    await decide(accountId, conversationId, "matter", "ctrl-by-user");
    const mark = markLogs();
    const result = await executeCommand(
      { accountId, provider: gmail },
      { type: "delete", conversationId, byUser: true },
      "ctrl-by-user",
    );
    assert.equal(result.ok, true);
    await drainOutbox(accountId, gmail);
    const thread = liveThreads.get("gmail-by-user");
    assert.ok(thread && trashedSince(mark).includes(thread.replyId), "byUser delete did not reach the provider");
  }

  {
    const foreign = await addConversation(db.pool, otherAccount, "gmail-foreign");
    const result = await executeCommand(
      { accountId, provider: gmail },
      { type: "triageConversation", conversationId: foreign, destination: "delete" },
      "ctrl-foreign",
    );
    assert.equal(result.ok, false);
    assert.equal((await outboxTypes(db.pool, accountId, foreign)).includes("trash"), false);
  }

  {
    // Desktop's token command already refuses once the decision id has moved,
    // even when the new decision is still delete. Mobile has to land here too.
    const sample = await planted(accountId, "gmail-desktop-stale", "delete", "delete", "ctrl-desktop");
    const row = mailboxRow(sample.conversationId, sample.staleToken);
    const command = sweepCommands([row], new Set([sample.conversationId]), "trash")[0]?.command;
    if (!command) throw new Error("desktop sweep produced no command");
    const mark = markLogs();
    const result = await executeCommand(
      { accountId, provider: gmail },
      command,
      "ctrl-desktop-stale",
    );
    assert.equal(result.ok, false);
    assert.match(result.error ?? "", /stale decision/);
    assert.equal((await foldersOf(db.pool, sample.conversationId)).includes("trash"), false);
    await drainOutbox(accountId, gmail);
    assert.equal(
      trashedSince(mark).some((id) => id === sample.thread.replyId),
      false,
    );
    assert.equal((await liveDecision(sample.conversationId)).id, sample.live.id);
  }

  // A cleared triage delete — token names the current delete decision — still
  // trashes the live thread. The fix must not turn every delete into an archive.
  {
    const conversationId = await addConversation(db.pool, accountId, "gmail-token-ok");
    const current = await decide(accountId, conversationId, "delete", "ctrl-token-ok");
    const token = signDecisionToken(current.id, conversationId);
    const thread = liveThreads.get("gmail-token-ok");
    if (!thread) throw new Error("missing token-ok thread");
    const mark = markLogs();
    const result = await executeCommand(
      { accountId, provider: gmail },
      {
        type: "triageConversation",
        conversationId,
        destination: "delete",
        deleteToken: token,
      } as Command,
      "ctrl-token-ok",
    );
    assert.equal(result.ok, true, "a token that names the current delete decision must still delete");
    await drainOutbox(accountId, gmail);
    const trashed = trashedSince(mark);
    assert.ok(trashed.includes(thread.replyId), "authorized triage delete did not trash the live reply");
  }

  // --- the sweep: decision changed before Delete all ---

  const cases: SweepExpect[] = [];

  async function pushCase(
    name: string,
    provider: "gmail" | "outlook" | "none",
    providerId: string,
    liveHome: Home,
    owner: AccountId,
    commandFor: (sample: Awaited<ReturnType<typeof planted>>) => Command,
    expectArchive: boolean,
    vetoReasons: string[] = [],
  ): Promise<void> {
    const sample = await planted(owner, providerId, "delete", liveHome, name, vetoReasons);
    cases.push({
      name,
      accountId: owner,
      conversationId: sample.conversationId,
      providerId,
      command: commandFor(sample),
      provider,
      expectArchive,
      live: sample.live,
    });
  }

  await pushCase(
    "gmail-matter",
    "gmail",
    "gmail-matter",
    "matter",
    accountId,
    (sample) => ({
      type: "triageConversation",
      conversationId: sample.conversationId,
      destination: "delete",
    }),
    true,
  );
  await pushCase(
    "outlook-matter",
    "outlook",
    "outlook-matter",
    "matter",
    accountId,
    (sample) => ({
      type: "triageConversation",
      conversationId: sample.conversationId,
      destination: "delete",
    }),
    true,
  );
  await pushCase(
    "gmail-veto",
    "gmail",
    "gmail-veto",
    "record",
    accountId,
    (sample) => ({
      type: "triageConversation",
      conversationId: sample.conversationId,
      destination: "delete",
    }),
    true,
    ["known_sender"],
  );
  // The current home is still delete, but it is a newer decision than the one
  // the pile was built from. No token is offered, so the old clearance is gone.
  await pushCase(
    "gmail-new-delete-id",
    "gmail",
    "gmail-new-delete-id",
    "delete",
    accountId,
    (sample) => ({
      type: "triageConversation",
      conversationId: sample.conversationId,
      destination: "delete",
    }),
    true,
  );
  await pushCase(
    "gmail-stale-token",
    "gmail",
    "gmail-stale-token",
    "matter",
    accountId,
    (sample) =>
      ({
        type: "triageConversation",
        conversationId: sample.conversationId,
        destination: "delete",
        deleteToken: sample.staleToken,
      }) as Command,
    true,
  );
  await pushCase(
    "gmail-wrong-conversation-token",
    "gmail",
    "gmail-wrong-token",
    "delete",
    accountId,
    (sample) =>
      ({
        type: "triageConversation",
        conversationId: sample.conversationId,
        destination: "delete",
        // Valid signature, but the clearance names a different conversation and
        // a different decision than the row that is current for this thread.
        deleteToken: signDecisionToken(
          "00000000-0000-4000-8000-000000000002",
          asConversationId("00000000-0000-4000-8000-000000000001"),
        ),
      }) as Command,
    true,
  );

  // Card deck: one verdict, same command, same missing check. Archive is not
  // required here because the deck may instead start sending the token-checked
  // delete command, which refuses a stale token without queueing archive.
  await pushCase(
    "deck-matter",
    "gmail",
    "gmail-deck",
    "matter",
    accountId,
    (sample) =>
      commandForVerdict(
        mailboxRow(sample.conversationId, sample.staleToken, "Deck card"),
        "delete",
      ),
    false,
  );

  // Leave habit records the correction without a provider mutation. The newer
  // decision still has to survive, and nothing may be queued as trash.
  await pushCase(
    "leave-matter",
    "none",
    "gmail-leave",
    "matter",
    leaveAccount,
    (sample) => ({
      type: "triageConversation",
      conversationId: sample.conversationId,
      destination: "delete",
    }),
    false,
  );

  for (const spec of cases) {
    await check(spec.name, () => runSweep(db, spec));
  }

  await check("mobile delete all", async () => {
    const matter = await planted(accountId, "gmail-ui-matter", "delete", "matter", "ui-matter");
    const veto = await planted(
      accountId,
      "gmail-ui-veto",
      "delete",
      "record",
      "ui-veto",
      ["known_sender"],
    );
    const rows = [
      mailboxRow(matter.conversationId, matter.staleToken, "Vendor digest"),
      mailboxRow(veto.conversationId, null, "Personal note"),
      mailboxRow(asConversationId("00000000-0000-4000-8000-000000000099"), null, "Live work", "matter"),
    ];
    const captured = await clickDeleteAll(rows);
    const expected = sweepCommands(
      rows.filter((row) => row.disposition === "delete"),
      new Set(rows.map((row) => row.conversationId)),
      "trash",
    ).map((item) => item.command);
    const problems: string[] = [];
    if (captured.length !== expected.length) {
      problems.push(`Delete all sent ${captured.length} commands, desktop sweep sends ${expected.length}`);
    }
    const actualById = new Map(captured.map((command) => [conversationOf(command), command]));
    for (const command of expected) {
      const actual = actualById.get(conversationOf(command));
      if (!sameSweepCommand(actual, command)) {
        problems.push(
          `${conversationOf(command)}: Delete all sent ${sketch(actual)}, desktop sweep sends ${sketch(command)}`,
        );
      }
    }
    const mark = markLogs();
    for (const [index, command] of captured.entries()) {
      await executeCommand({ accountId, provider: gmail }, command, `ui-delete-all-${index}`);
    }
    await drainOutbox(accountId, gmail);
    for (const sample of [matter, veto]) {
      const decision = await liveDecision(sample.conversationId);
      const folders = await foldersOf(db.pool, sample.conversationId);
      const queued = await outboxTypes(db.pool, accountId, sample.conversationId);
      if (decision.id !== sample.live.id) {
        problems.push(`${sample.providerId} decision overwritten to ${decision.summary}`);
      }
      if (queued.includes("trash") || folders.includes("trash")) {
        problems.push(`${sample.providerId} was trashed by Delete all`);
      }
    }
    const trashed = trashedSince(mark);
    for (const sample of [matter, veto]) {
      if (trashed.includes(sample.thread.replyId) || trashed.includes(sample.thread.originalId)) {
        problems.push(`${sample.providerId} live messages trashed: ${trashed.join(",")}`);
      }
    }
    if (problems.length > 0) throw new Error(problems.join("; "));
  });

  if (failures.length > 0) {
    throw new Error(`mobile triage delete sweep failed\n\n${failures.join("\n\n")}`);
  }
  console.log("mobile-triage-delete-sweep: ok");
} finally {
  await db.stop();
}

function mailboxRow(
  conversationId: string,
  deleteToken: string | null,
  subject = "Subject",
  disposition: MailboxRow["disposition"] = "delete",
): MailboxRow {
  return {
    conversationId,
    providerConversationId: `provider-${conversationId}`,
    senderDisplayName: "Counterparty",
    subject,
    timestamp: "2026-08-17T09:00:00.000Z",
    isUnread: false,
    snippet: "",
    attachments: [],
    decisionSummary: null,
    priority: null,
    dueDate: null,
    matterTitle: null,
    disposition,
    owner: "nobody",
    deleteRank: 1,
    deleteToken,
    category: null,
    vetoReasons: [],
  };
}

function conversationOf(command: Command | undefined): string {
  if (command && "conversationId" in command) return command.conversationId;
  return "";
}

function sketch(command: Command | undefined): string {
  if (!command) return "nothing";
  if (command.type === "delete") {
    return `delete token=${command.deleteToken ? "yes" : "no"} byUser=${command.byUser ? "yes" : "no"}`;
  }
  if (command.type === "archive") return "archive";
  if (command.type === "triageConversation") return `triageConversation:${command.destination}`;
  return command.type;
}

function sameSweepCommand(actual: Command | undefined, expected: Command): boolean {
  if (!actual || actual.type !== expected.type) return false;
  if (actual.type === "archive" && expected.type === "archive") {
    return actual.conversationId === expected.conversationId;
  }
  if (actual.type === "delete" && expected.type === "delete") {
    return (
      actual.conversationId === expected.conversationId &&
      actual.deleteToken === expected.deleteToken &&
      !actual.byUser
    );
  }
  return false;
}

async function clickDeleteAll(rows: MailboxRow[]): Promise<Command[]> {
  const dom = new (await import("jsdom")).JSDOM("<!doctype html><html><body></body></html>", {
    pretendToBeVisual: true,
    url: "http://localhost/",
  });
  const { window } = dom;
  const globals = globalThis as unknown as Record<string, unknown>;
  globals.window = window;
  globals.document = window.document;
  Object.defineProperty(globals, "navigator", { value: window.navigator, configurable: true });
  globals.HTMLElement = window.HTMLElement;
  globals.Element = window.Element;
  globals.Node = window.Node;
  globals.MouseEvent = window.MouseEvent;
  globals.KeyboardEvent = window.KeyboardEvent;
  globals.IS_REACT_ACT_ENVIRONMENT = true;

  const { createElement, act } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { MobileMailboxList } = await import("../src/components/v3/MobileMailboxList.tsx");

  const view: MailboxView = {
    accountId: "sweep-account",
    folder: "inbox",
    sort: "triage",
    rows,
    total: rows.length,
    needsYou: 0,
    nextCursor: null,
  };
  const captured: Command[] = [];
  const container = window.document.createElement("div");
  window.document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(
      createElement(MobileMailboxList, {
        view,
        triage: true,
        onOpen: () => {},
        onCommands: (commands) => {
          captured.push(...commands);
          return Promise.resolve(commands.map(() => ({ ok: true, replayed: false })));
        },
      }),
    );
  });
  const button = [...container.querySelectorAll("button")].find((node) =>
    node.textContent?.includes("Delete all"),
  );
  if (!button) throw new Error("Delete all button was not rendered");
  await act(async () => {
    button.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  });
  await act(async () => {
    root.unmount();
  });
  container.remove();
  return captured;
}
