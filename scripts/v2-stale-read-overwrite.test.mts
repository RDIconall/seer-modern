/**
 * A placement the owner saves while the chief-of-staff model call is still
 * running has to remain the current decision. The queue already refuses to
 * pick a conversation whose current row is a user correction. The write that
 * stores the finished read does not: it clears every current decision for the
 * conversation and inserts the model result.
 *
 * These tests drive the scheduled reader (`readBatch`) and the shadow rebuild
 * (`runShadow`). Both call `readConversation`, which calls the model outside
 * any lock and then `saveDecision`. A correction committed in that gap — and
 * one committed after an unlocked re-check but before the conversation row
 * lock — must still be the current row, still the matter the owner chose, and
 * must not be offered on the disposable list or removed by a clear of that list.
 */
import assert from "node:assert/strict";
import type { Pool, PoolClient } from "pg";
import { startTestDb, type TestDb } from "./v2-testdb.mts";
import { upsertAccount, upsertUser } from "../src/lib/v2/db/accounts.ts";
import { asConversationId, type AccountId, type ConversationId } from "../src/lib/v2/db/types.ts";
import { conversationsNeedingRead } from "../src/lib/v2/intelligence/queue.ts";
import { readBatch } from "../src/lib/v2/intelligence/read-batch.ts";
import { currentDecision } from "../src/lib/v2/intelligence/repository.ts";
import type { ReadResult } from "../src/lib/v2/intelligence/schema.ts";
import { executeCommand } from "../src/lib/v2/commands/execute.ts";
import { runShadow } from "../src/lib/v2/shadow/run.ts";
import type { ContextInput } from "../src/lib/v2/intelligence/context.ts";
import { buildInboxView } from "../src/lib/v2/view/build.ts";
import { commandFor } from "../src/components/v2/triage-command.ts";
import { getMailboxView } from "../src/lib/v3/mailbox/repository.ts";

const OWNER = "owner@example.com";
const SENDER = "newsletters@vendor.test";
const BODY = "Weekly offers and product updates. Unsubscribe at the bottom of this message.";

const disposable: ReadResult = {
  home: "delete",
  summary: "Vendor newsletter",
  rationale: "No ask and no record to keep",
  owner: "nobody",
  ask: "nothing — informational",
  obligation: false,
  yields: [],
  evidence: [],
};

const otherMatter: ReadResult = {
  home: "matter",
  summary: "Vendor wants a renewal decision",
  rationale: "A direct request with a deadline",
  owner: "you",
  ask: "Please confirm the renewal",
  obligation: true,
  matterRef: "Vendor renewal campaign",
  yields: [],
  evidence: [],
};

type Placement = () => Promise<void>;

const pendingPlacement = new Map<string, Placement>();

function queryText(query: unknown): string {
  if (typeof query === "string") return query;
  if (query && typeof query === "object" && "text" in query) {
    return String((query as { text: unknown }).text ?? "");
  }
  return "";
}

function queryParams(query: unknown, values: unknown): unknown[] {
  if (Array.isArray(values)) return values;
  if (query && typeof query === "object" && "values" in query) {
    const nested = (query as { values: unknown }).values;
    if (Array.isArray(nested)) return nested;
  }
  return [];
}

/**
 * Conversation id addressed by the two writes that replace a placement: the
 * conversation-row lock inside `saveDecision`, and the matter link the reader
 * inserts before that lock.
 */
function conversationTarget(text: string, params: unknown[]): string | null {
  const locksConversation =
    /for update/i.test(text) &&
    /seer\.conversations/i.test(text) &&
    !/matter_conversations/i.test(text);
  if (locksConversation && typeof params[0] === "string") return params[0];
  if (/insert into seer\.matter_conversations/i.test(text) && typeof params[1] === "string") {
    return params[1];
  }
  return null;
}

function takePlacement(text: string, params: unknown[]): Promise<void> | null {
  const id = conversationTarget(text, params);
  if (!id) return null;
  const place = pendingPlacement.get(id);
  if (!place) return null;
  // Drop the barrier before awaiting. The placement writes the same statements,
  // and it must commit before this statement runs.
  pendingPlacement.delete(id);
  return place();
}

const WRAPPED = Symbol.for("seer.stale-overwrite.wrapped");

function wrapClient(client: PoolClient): PoolClient {
  const marked = client as PoolClient & { [WRAPPED]?: boolean };
  if (marked[WRAPPED]) return client;
  marked[WRAPPED] = true;
  const original = client.query.bind(client) as PoolClient["query"];
  client.query = ((...args: unknown[]) => {
    const before = takePlacement(queryText(args[0]), queryParams(args[0], args[1]));
    const run = () => original(...(args as Parameters<PoolClient["query"]>));
    return before ? before.then(() => run()) : run();
  }) as PoolClient["query"];
  return client;
}

/**
 * Commit a registered placement immediately before the reader locks the
 * conversation or links a matter. A re-check that is not under that same lock
 * has already returned by the time either statement runs.
 */
function installPlacementBarrier(pool: Pool): void {
  const connect = pool.connect.bind(pool) as Pool["connect"];
  const query = pool.query.bind(pool) as Pool["query"];

  pool.connect = ((...args: unknown[]) => {
    if (typeof args[0] === "function") {
      return connect(...(args as Parameters<Pool["connect"]>));
    }
    return (connect() as Promise<PoolClient>).then((client) => wrapClient(client));
  }) as Pool["connect"];

  pool.query = ((...args: unknown[]) => {
    const before = takePlacement(queryText(args[0]), queryParams(args[0], args[1]));
    const run = () => query(...(args as Parameters<Pool["query"]>));
    return before ? before.then(() => run()) : run();
  }) as Pool["query"];
}

async function addInbox(
  pool: Pool,
  accountId: AccountId,
  providerId: string,
): Promise<ConversationId> {
  const row = await pool.query<{ id: string }>(
    `insert into seer.conversations
       (account_id, provider_conversation_id, subject, folders, last_message_at)
     values ($1, $2, $3, array['inbox'], now())
     returning id`,
    [accountId, providerId, `Weekly digest ${providerId}`],
  );
  const id = row.rows[0].id;
  await pool.query(
    `insert into seer.messages
       (account_id, conversation_id, provider_message_id, from_email, to_emails,
        sent_at, body_text, snippet, is_unread, is_outgoing)
     values ($1, $2, $3, $4, array[$5], now(), $6, $7, true, false)`,
    [accountId, id, `${providerId}-m`, SENDER, OWNER, BODY, BODY.slice(0, 80)],
  );
  return asConversationId(id);
}

async function addMatter(pool: Pool, accountId: AccountId, title: string): Promise<string> {
  const row = await pool.query<{ id: string }>(
    `insert into seer.matters (account_id, title, title_source)
     values ($1, $2, 'user')
     returning id`,
    [accountId, title],
  );
  return row.rows[0].id;
}

async function keep(
  accountId: AccountId,
  conversationId: ConversationId,
  key: string,
): Promise<string> {
  const result = await executeCommand(
    { accountId },
    {
      type: "correctConversation",
      conversationId,
      home: "record",
      note: "Kept by you",
    },
    key,
  );
  assert.equal(result.ok, true, result.error ?? "keep was not recorded");
  const current = await currentDecision(accountId, conversationId);
  assert.equal(current?.modelVersion, "user-correction");
  assert.ok(current?.id);
  return current.id;
}

async function fileOn(
  accountId: AccountId,
  conversationId: ConversationId,
  matterId: string,
  key: string,
): Promise<string> {
  const result = await executeCommand(
    { accountId },
    {
      type: "correctConversation",
      conversationId,
      home: "matter",
      note: "Filed by you",
      matterId,
    },
    key,
  );
  assert.equal(result.ok, true, result.error ?? "filing was not recorded");
  const current = await currentDecision(accountId, conversationId);
  assert.equal(current?.modelVersion, "user-correction");
  assert.equal(current?.home, "matter");
  assert.equal(current?.matterId, matterId);
  assert.ok(current?.id);
  return current.id;
}

async function archiveInTriage(
  accountId: AccountId,
  conversationId: ConversationId,
  key: string,
): Promise<string> {
  const result = await executeCommand(
    { accountId },
    { type: "triageConversation", conversationId, destination: "archive" },
    key,
  );
  assert.equal(result.ok, true, result.error ?? "archive was not recorded");
  const current = await currentDecision(accountId, conversationId);
  assert.equal(current?.modelVersion, "user-correction");
  assert.equal(current?.home, "record");
  assert.ok(current?.id);
  return current.id;
}

async function foldersOf(pool: Pool, conversationId: string): Promise<string[]> {
  const row = await pool.query<{ folders: string[] }>(
    "select folders from seer.conversations where id = $1",
    [conversationId],
  );
  return row.rows[0]?.folders ?? [];
}

async function linksOf(
  pool: Pool,
  conversationId: string,
): Promise<{ matterId: string; source: string }[]> {
  const rows = await pool.query<{ matter_id: string; link_source: string }>(
    `select matter_id, link_source
       from seer.matter_conversations
      where conversation_id = $1
      order by link_source, matter_id`,
    [conversationId],
  );
  return rows.rows.map((row) => ({ matterId: row.matter_id, source: row.link_source }));
}

/**
 * Clear the disposable list the way the product does: only a row the inbox
 * view or the triage sort minted a delete token for. Returns true when that
 * clear removed the message.
 */
async function clearDisposable(
  accountId: AccountId,
  conversationId: string,
  key: string,
): Promise<boolean> {
  const [inbox, triage] = await Promise.all([
    buildInboxView(accountId, "google"),
    getMailboxView(accountId, "inbox", 50, undefined, "triage"),
  ]);
  const offered = inbox.safeToDelete.find((row) => row.conversationId === conversationId);
  const sorted = triage.rows.find((row) => row.conversationId === conversationId);
  const token = offered?.deleteToken ?? sorted?.deleteToken ?? null;
  if (!token) return false;
  const command = commandFor({ conversationId, deleteToken: token }, "trash");
  const result = await executeCommand({ accountId }, command, key);
  return result.ok === true;
}

async function readOne(
  accountId: AccountId,
  ownEmail: string,
  conversationId: ConversationId,
  model: ReadResult,
  duringModel?: () => Promise<void>,
): Promise<void> {
  const queued = await conversationsNeedingRead(accountId);
  assert.ok(
    queued.some((id) => String(id) === String(conversationId)),
    "the scheduled reader must select mail that has no user correction yet",
  );
  await readBatch(accountId, ownEmail, async (input) => {
    if (String(input.conversationId) !== String(conversationId)) {
      throw new Error(`unexpected conversation ${input.conversationId}`);
    }
    if (duringModel) await duringModel();
    return model;
  }, { limit: 10, concurrency: 1 });
}

const failures: string[] = [];

async function runCase(name: string, body: () => Promise<void>): Promise<void> {
  try {
    await body();
    console.log(`ok ${name}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    failures.push(`${name}: ${message}`);
    console.error(`FAIL ${name}: ${message}`);
  }
}

const db: TestDb = await startTestDb();
installPlacementBarrier(db.pool);
try {
  const isolation = await db.pool.query<{ default_transaction_isolation: string }>(
    "show default_transaction_isolation",
  );
  assert.equal(isolation.rows[0]?.default_transaction_isolation, "read committed");

  const userId = await upsertUser(OWNER);
  const accountId = await upsertAccount({
    userId,
    provider: "google",
    email: OWNER,
  });
  const boardMatter = await addMatter(db.pool, accountId, "Board minutes");

  // The classification under test really is disposable. Safety lets it through,
  // the inbox offers it, and a clear of that list removes it.
  await runCase("uncorrected newsletter is offered and cleared", async () => {
    const id = await addInbox(db.pool, accountId, "control-delete");
    await readOne(accountId, OWNER, id, disposable);
    const current = await currentDecision(accountId, id);
    assert.equal(current?.home, "delete", "an uncorrected newsletter is classified delete");
    const removed = await clearDisposable(accountId, id, "clear-control");
    assert.equal(removed, true, "a clear of the disposable list removes uncorrected mail");
    assert.ok((await foldersOf(db.pool, id)).includes("trash"));
  });

  // Owner keeps the thread while the model call is in flight.
  await runCase("keep during the model call stays current", async () => {
    const id = await addInbox(db.pool, accountId, "keep-during-model");
    let placementId = "";
    await readOne(accountId, OWNER, id, disposable, async () => {
      placementId = await keep(accountId, id, "keep-during-model");
      const stillQueued = await conversationsNeedingRead(accountId);
      assert.ok(
        !stillQueued.some((queued) => String(queued) === String(id)),
        "the queue treats the correction as final once it is current",
      );
    });
    assert.equal(
      await clearDisposable(accountId, id, "clear-keep"),
      false,
      "mail the owner kept must not be cleared with the disposable list",
    );
    assert.ok(!(await foldersOf(db.pool, id)).includes("trash"));
    const current = await currentDecision(accountId, id);
    assert.equal(
      current?.id,
      placementId,
      `the finished read replaced the keep (home=${current?.home} model=${current?.modelVersion})`,
    );
    assert.equal(current?.modelVersion, "user-correction");
    assert.equal(current?.home, "record");
  });

  // Owner files the thread onto a matter while the model call is in flight,
  // and the model comes back delete.
  await runCase("filing during the model call stays on that matter", async () => {
    const id = await addInbox(db.pool, accountId, "file-then-delete");
    let placementId = "";
    await readOne(accountId, OWNER, id, disposable, async () => {
      placementId = await fileOn(accountId, id, boardMatter, "file-then-delete");
    });
    assert.equal(await clearDisposable(accountId, id, "clear-filed"), false);
    assert.ok(!(await foldersOf(db.pool, id)).includes("trash"));
    const view = await buildInboxView(accountId, "google");
    const card = view.atlas.find((matter) => matter.matterId === boardMatter);
    assert.ok(
      card?.conversations.some((row) => row.conversationId === id),
      "the matter the owner chose must still contain the thread",
    );
    const current = await currentDecision(accountId, id);
    assert.equal(
      current?.id,
      placementId,
      `the finished read pulled the thread off the matter (home=${current?.home} matter=${current?.matterId})`,
    );
    assert.equal(current?.home, "matter");
    assert.equal(current?.matterId, boardMatter);
  });

  // Same filing, but the model promotes a different matter and links it.
  await runCase("filing during the model call is not relinked", async () => {
    const id = await addInbox(db.pool, accountId, "file-then-relink");
    const ownMatter = await addMatter(db.pool, accountId, "Board minutes follow-up");
    let placementId = "";
    await readOne(accountId, OWNER, id, otherMatter, async () => {
      placementId = await fileOn(accountId, id, ownMatter, "file-then-relink");
    });
    const links = await linksOf(db.pool, id);
    assert.deepEqual(
      links,
      [{ matterId: ownMatter, source: "user" }],
      `the reader linked a matter the owner did not choose: ${JSON.stringify(links)}`,
    );
    const current = await currentDecision(accountId, id);
    assert.equal(current?.id, placementId);
    assert.equal(current?.modelVersion, "user-correction");
    assert.equal(current?.matterId, ownMatter);
  });

  // Owner archives from Triage while the model call is in flight.
  await runCase("triage archive during the model call stays current", async () => {
    const id = await addInbox(db.pool, accountId, "archive-during-model");
    let placementId = "";
    await readOne(accountId, OWNER, id, disposable, async () => {
      placementId = await archiveInTriage(accountId, id, "archive-during-model");
    });
    const current = await currentDecision(accountId, id);
    assert.equal(
      current?.id,
      placementId,
      `the finished read replaced the archive (home=${current?.home} model=${current?.modelVersion})`,
    );
    assert.equal(current?.home, "record");
    assert.deepEqual((await foldersOf(db.pool, id)).sort(), ["archive"]);
  });

  // The correction commits after any unlocked re-check, on the statement that
  // locks the conversation, and before that lock is acquired.
  await runCase("keep committed before the conversation lock stays current", async () => {
    const id = await addInbox(db.pool, accountId, "keep-after-check");
    let placementId = "";
    pendingPlacement.set(String(id), async () => {
      placementId = await keep(accountId, id, "keep-after-check");
    });
    await readOne(accountId, OWNER, id, disposable);
    assert.ok(placementId, "the keep must commit before the reader replaces the decision");
    assert.equal(await clearDisposable(accountId, id, "clear-after-check"), false);
    assert.ok(!(await foldersOf(db.pool, id)).includes("trash"));
    const current = await currentDecision(accountId, id);
    assert.equal(
      current?.id,
      placementId,
      `a correction committed before the conversation lock was overwritten (home=${current?.home} model=${current?.modelVersion})`,
    );
  });

  // Same window, for a filing: the barrier fires on the matter link as well as
  // the conversation lock, so a check that then links anyway still loses.
  await runCase("filing committed before the matter link stays on that matter", async () => {
    const id = await addInbox(db.pool, accountId, "file-after-check");
    const ownMatter = await addMatter(db.pool, accountId, "Owner shelf");
    let placementId = "";
    pendingPlacement.set(String(id), async () => {
      placementId = await fileOn(accountId, id, ownMatter, "file-after-check");
    });
    await readOne(accountId, OWNER, id, otherMatter);
    assert.ok(placementId, "the filing must commit before the reader links a matter");
    const links = await linksOf(db.pool, id);
    assert.deepEqual(
      links,
      [{ matterId: ownMatter, source: "user" }],
      `the reader still linked its own matter: ${JSON.stringify(links)}`,
    );
    const current = await currentDecision(accountId, id);
    assert.equal(current?.id, placementId);
    assert.equal(current?.matterId, ownMatter);
  });

  // Shadow rebuild calls the same reader without going through the queue.
  await runCase("shadow rebuild keeps a correction made during its model call", async () => {
    const shadowUser = await upsertUser("shadow-owner@example.com");
    const shadowAccount = await upsertAccount({
      userId: shadowUser,
      provider: "google",
      email: "shadow-owner@example.com",
    });
    const id = await addInbox(db.pool, shadowAccount, "shadow-keep");
    let placementId = "";
    const context: ContextInput = {
      ownDomain: "example.com",
      ownEmail: "shadow-owner@example.com",
      people: [],
      matters: [],
      interests: [],
      placements: [],
    };
    await runShadow({
      accountId: shadowAccount,
      account: "shadow-owner@example.com",
      context,
      benchmark: null,
      providerParityPassed: true,
      model: async (input) => {
        if (String(input.conversationId) !== String(id)) return disposable;
        placementId = await keep(shadowAccount, id, "shadow-keep");
        return disposable;
      },
    });
    assert.equal(
      await clearDisposable(shadowAccount, id, "clear-shadow"),
      false,
      "a shadow rebuild must not put kept mail back on the disposable list",
    );
    const current = await currentDecision(shadowAccount, id);
    assert.equal(
      current?.id,
      placementId,
      `shadow rebuild replaced the keep (home=${current?.home} model=${current?.modelVersion})`,
    );
  });

  if (failures.length > 0) {
    throw new Error(failures.join("\n"));
  }
  console.log("v2-stale-read-overwrite: OK");
} finally {
  await db.stop();
}
