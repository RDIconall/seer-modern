/**
 * Approving a chief-of-staff triage proposal must move only the conversation
 * the signed-in user was shown, and only with the action they were shown.
 *
 * These tests fail while the server re-reads the proposal row and archives,
 * trashes, or files whatever action and conversation are stored at click time.
 * The approve command the client sends is only the proposal id and the word
 * approved. The seer_bot role can rewrite that row after the screen is drawn.
 *
 * They pass once both of these hold:
 * - The approve command carries the action, conversation, provider
 *   conversation, subject, and destination that were on screen, and the
 *   server refuses it — with no outbox row and no provider move — when the
 *   stored row differs, including when a later read of the same row differs
 *   from the read that was compared.
 * - seer_bot can still insert a pending proposal, and cannot update action,
 *   conversation_id, provider_conversation_id, or destination_id, and cannot
 *   set status to approved or executed.
 */
import assert from "node:assert/strict";
import type { Pool, PoolClient } from "pg";
import { startTestDb } from "./v2-testdb.mts";
import { upsertAccount, upsertUser } from "../src/lib/v2/db/accounts.ts";
import { executeCommand } from "../src/lib/v2/commands/execute.ts";
import { asConversationId, type AccountId } from "../src/lib/v2/db/types.ts";
import { insertProposal, loadStaffView } from "../src/lib/v2/staff/repository.ts";
import type { StaffProposal, TriageAction } from "../src/lib/v2/staff/types.ts";
import type { Command } from "../src/lib/v2/commands/types.ts";
import type { MailProvider, MoveReceipt } from "../src/lib/v2/providers/types.ts";
import { db } from "../src/lib/v2/db/pool.ts";

delete process.env.SEER_BOT_WEBHOOK_URL;
delete process.env.SEER_BOT_WEBHOOK_SECRET;

type Binding = {
  action: TriageAction;
  conversationId: string | null;
  providerConversationId: string | null;
  subject: string | null;
  destinationId: string | null;
};

type MoveCall = { id: string; destinationId: string };

type MailSnapshot = {
  folders: Array<{ id: string; folders: string[] }>;
  outbox: Array<{ type: string; conversationId: string }>;
};

const failures: string[] = [];

async function check(name: string, run: () => Promise<void>): Promise<void> {
  try {
    await run();
    console.log(`PASS ${name}`);
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    failures.push(`${name}: ${message}`);
    console.error(`FAIL ${name}: ${message}`);
  }
}

function bindingOf(proposal: StaffProposal): Binding {
  return {
    action: proposal.action,
    conversationId: proposal.conversationId,
    providerConversationId: proposal.providerConversationId,
    subject: proposal.subject,
    destinationId: proposal.destinationId,
  };
}

/** The command the fixed client must send: the proposal the user was shown. */
function boundApproval(proposalId: string, shown: Binding): Command {
  return {
    type: "decideTriageProposal",
    proposalId,
    decision: "approved",
    action: shown.action,
    conversationId: shown.conversationId,
    providerConversationId: shown.providerConversationId,
    subject: shown.subject,
    destinationId: shown.destinationId,
  } as Command;
}

/** The command MailClient sends today. */
function unboundApproval(proposalId: string): Command {
  return {
    type: "decideTriageProposal",
    proposalId,
    decision: "approved",
  };
}

function overTheWire(command: Command): Command {
  return JSON.parse(JSON.stringify(command)) as Command;
}

function recordingProvider(): MailProvider & { moves: MoveCall[] } {
  const moves: MoveCall[] = [];
  const unused = async (): Promise<never> => {
    throw new Error("provider method is not part of this approval");
  };
  return {
    kind: "google",
    moves,
    sync: unused,
    syncFolder: unused,
    getConversation: unused,
    search: unused,
    send: unused,
    reply: unused,
    forward: unused,
    getAttachment: unused,
    listFolders: unused,
    async moveConversation(id: string, destinationId: string): Promise<MoveReceipt> {
      moves.push({ id, destinationId });
      return { conversationId: id, destinationId, processed: ["m1"], failed: [] };
    },
    mutateConversation: unused,
    nativeUrl: (id: string) => `https://mail.example/${id}`,
  };
}

async function addConversation(
  pool: Pool,
  accountId: AccountId,
  providerId: string,
  subject: string,
): Promise<string> {
  const created = await pool.query<{ id: string }>(
    `insert into seer.conversations
       (account_id, provider_conversation_id, subject, folders, is_unread)
     values ($1, $2, $3, $4::text[], false)
     returning id`,
    [accountId, providerId, subject, ["inbox"]],
  );
  return created.rows[0].id;
}

async function mailSnapshot(pool: Pool, accountId: AccountId): Promise<MailSnapshot> {
  const folders = await pool.query<{ id: string; folders: string[] }>(
    "select id, folders from seer.conversations where account_id = $1 order by id",
    [accountId],
  );
  const outbox = await pool.query<{ command: { type: string; conversationId: string } }>(
    "select command from seer.outbox where account_id = $1 order by created_at, id",
    [accountId],
  );
  return {
    folders: folders.rows.map((row) => ({
      id: row.id,
      folders: [...row.folders].sort(),
    })),
    outbox: outbox.rows.map((row) => ({
      type: row.command.type,
      conversationId: row.command.conversationId,
    })),
  };
}

function assertUntouched(
  before: MailSnapshot,
  after: MailSnapshot,
  movesBefore: number,
  movesAfter: number,
  label: string,
): void {
  assert.deepEqual(after.folders, before.folders, `${label}: conversation folders changed`);
  assert.deepEqual(after.outbox, before.outbox, `${label}: an outbox mail command was queued`);
  assert.equal(movesAfter, movesBefore, `${label}: provider moveConversation ran`);
}

async function shownProposal(
  accountId: AccountId,
  proposalId: string,
): Promise<StaffProposal> {
  const view = await loadStaffView(accountId);
  const proposal = view.proposals.find((row) => row.id === proposalId);
  assert.ok(proposal, "the pending proposal is on the Atlas staff view");
  return proposal;
}

async function retarget(
  pool: Pool,
  proposalId: string,
  next: {
    action: TriageAction;
    conversationId: string | null;
    providerConversationId: string | null;
    subject: string | null;
    destinationId: string | null;
    destinationName: string | null;
  },
): Promise<void> {
  await pool.query(
    `update seer.triage_proposals set
       action = $2,
       conversation_id = $3,
       provider_conversation_id = $4,
       subject = $5,
       destination_id = $6,
       destination_name = $7,
       status = 'pending'
     where id = $1`,
    [
      proposalId,
      next.action,
      next.conversationId,
      next.providerConversationId,
      next.subject,
      next.destinationId,
      next.destinationName,
    ],
  );
}

async function approve(
  accountId: AccountId,
  command: Command,
  idempotencyKey: string,
  provider: MailProvider,
) {
  return executeCommand(
    { accountId, provider },
    overTheWire(command),
    idempotencyKey,
  );
}

function queryText(config: unknown): string {
  if (typeof config === "string") return config;
  if (config && typeof config === "object" && "text" in config) {
    return String((config as { text: unknown }).text ?? "");
  }
  return "";
}

function isProposalRead(sql: string): boolean {
  return /^\s*select\b/i.test(sql) && /\bfrom\s+seer\.triage_proposals\b/i.test(sql);
}

/**
 * After the first read of a proposal during a command, change the row before
 * any later read. A fix that compares one snapshot and then executes a fresher
 * read still moves the mail the user did not approve.
 */
function swapBeforeLaterProposalReads(
  pool: Pool,
  swap: () => Promise<void>,
): () => number {
  const originalQuery = pool.query.bind(pool);
  const originalConnect = pool.connect.bind(pool);
  const wrappedClients = new WeakSet<object>();
  let reads = 0;
  const note = async (sql: string) => {
    if (!isProposalRead(sql)) return;
    reads += 1;
    if (reads >= 2) await swap();
  };
  // pg calls query both as a promise and with a node-style callback. Dropping
  // the callback parks the pooled client forever.
  const wrapQuery = (runner: Pool | PoolClient, original: Pool["query"] | PoolClient["query"]) => {
    const wrapped = function (this: Pool | PoolClient, text: unknown, values?: unknown, cb?: unknown) {
      let callback = cb;
      let params = values;
      if (typeof values === "function") {
        callback = values;
        params = undefined;
      }
      const run = () => {
        if (typeof callback === "function") {
          return params === undefined
            ? original.call(runner, text as never, callback as never)
            : original.call(runner, text as never, params as never, callback as never);
        }
        return params === undefined
          ? original.call(runner, text as never)
          : original.call(runner, text as never, params as never);
      };
      if (!isProposalRead(queryText(text))) return run();
      const pending = note(queryText(text));
      if (typeof callback === "function") {
        const done = callback as (err: unknown) => void;
        pending.then(() => run()).catch((err) => done(err));
        return undefined;
      }
      return pending.then(() => run());
    };
    runner.query = wrapped as Pool["query"];
  };
  wrapQuery(pool, originalQuery);
  pool.connect = ((callback?: unknown) => {
    if (typeof callback === "function") return originalConnect(callback as never);
    return originalConnect().then((client) => {
      if (!wrappedClients.has(client)) {
        wrappedClients.add(client);
        wrapQuery(client, client.query.bind(client));
      }
      return client;
    });
  }) as Pool["connect"];
  return () => {
    pool.query = originalQuery as Pool["query"];
    pool.connect = originalConnect as Pool["connect"];
    return reads;
  };
}

async function withBot<T>(pool: Pool, run: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("set role seer_bot");
    return await run(client);
  } finally {
    await client.query("reset role");
    client.release();
  }
}

async function denied(run: () => Promise<unknown>): Promise<boolean> {
  try {
    await run();
    return false;
  } catch {
    return true;
  }
}

const database = await startTestDb();
const pool = database.pool;
try {
  const userId = await upsertUser("approval-binding@example.com");
  const accountId = await upsertAccount({
    userId,
    provider: "google",
    email: "approval-binding@example.com",
  });
  const provider = recordingProvider();
  const bot = await pool.query<{ id: string }>(
    "select id from seer.bots where slug = 'chief-of-staff'",
  );
  const botId = bot.rows[0].id;

  await check("seer_bot cannot queue mail on its own", async () => {
    const blocked = await withBot(pool, async (client) =>
      denied(() =>
        client.query(
          `insert into seer.outbox (account_id, command, idempotency_key)
           values ($1, $2::jsonb, 'bot-direct-trash')`,
          [accountId, JSON.stringify({ type: "trash", conversationId: "none" })],
        ),
      ),
    );
    assert.equal(blocked, true, "seer_bot inserted into seer.outbox");
    const leftover = await pool.query(
      "select count(*)::int as n from seer.outbox where account_id = $1",
      [accountId],
    );
    assert.equal(leftover.rows[0].n, 0, "a refused bot outbox insert still left a row");
  });

  await check("seer_bot cannot rewrite a proposal after insert", async () => {
    const shownId = await addConversation(pool, accountId, "pc-bot-shown", "Low value");
    const victimId = await addConversation(pool, accountId, "pc-bot-victim", "Invoice");
    const inserted = await withBot(pool, async (client) => {
      const row = await client.query<{ id: string }>(
        `insert into seer.triage_proposals
           (account_id, bot_id, conversation_id, provider_conversation_id,
            sender_email, subject, action, rationale)
         values ($1, $2, $3, 'pc-bot-shown', 'deals@shop.test', 'Low value', 'archive', 'noise')
         returning id`,
        [accountId, botId, shownId],
      );
      return row.rows[0].id;
    });

    const updates: Array<[string, string, unknown[]]> = [
      [
        "action",
        `update seer.triage_proposals set action = 'delete' where id = $1`,
        [inserted],
      ],
      [
        "conversation_id",
        `update seer.triage_proposals set conversation_id = $2 where id = $1`,
        [inserted, victimId],
      ],
      [
        "provider_conversation_id",
        `update seer.triage_proposals set provider_conversation_id = 'pc-bot-victim' where id = $1`,
        [inserted],
      ],
      [
        "destination_id",
        `update seer.triage_proposals set destination_id = 'folder-other' where id = $1`,
        [inserted],
      ],
      [
        "status approved",
        `update seer.triage_proposals set status = 'approved' where id = $1`,
        [inserted],
      ],
      [
        "status executed",
        `update seer.triage_proposals set status = 'executed' where id = $1`,
        [inserted],
      ],
    ];

    const allowed: string[] = [];
    await withBot(pool, async (client) => {
      for (const [column, sql, values] of updates) {
        const blocked = await denied(() => client.query(sql, values));
        if (!blocked) allowed.push(column);
      }
    });
    assert.deepEqual(allowed, [], `seer_bot updated ${allowed.join(", ")}`);

    const stored = await pool.query<{
      action: string;
      conversation_id: string;
      provider_conversation_id: string;
      destination_id: string | null;
      status: string;
    }>(
      `select action, conversation_id, provider_conversation_id, destination_id, status
         from seer.triage_proposals where id = $1`,
      [inserted],
    );
    assert.equal(stored.rows[0].action, "archive");
    assert.equal(stored.rows[0].conversation_id, shownId);
    assert.equal(stored.rows[0].provider_conversation_id, "pc-bot-shown");
    assert.equal(stored.rows[0].destination_id, null);
    assert.equal(stored.rows[0].status, "pending");
  });

  async function propose(
    input: {
      providerId: string;
      subject: string;
      action: TriageAction;
      destinationId?: string | null;
      destinationName?: string | null;
    },
  ): Promise<{ shown: StaffProposal; conversationId: string }> {
    const conversationId = await addConversation(
      pool,
      accountId,
      input.providerId,
      input.subject,
    );
    const created = await insertProposal({
      accountId,
      conversationId: asConversationId(conversationId),
      providerConversationId: input.providerId,
      senderEmail: "deals@shop.test",
      subject: input.subject,
      action: input.action,
      destinationId: input.destinationId ?? null,
      destinationName: input.destinationName ?? null,
      rationale: "Low value",
    });
    const shown = await shownProposal(accountId, created.id);
    assert.equal(shown.action, input.action);
    assert.equal(shown.conversationId, conversationId);
    assert.equal(shown.subject, input.subject);
    assert.equal(shown.status, "pending");
    return { shown, conversationId };
  }

  async function expectRefusal(
    label: string,
    proposalId: string,
    command: Command,
    key: string,
  ): Promise<void> {
    const before = await mailSnapshot(pool, accountId);
    const movesBefore = provider.moves.length;
    const result = await approve(accountId, command, key, provider);
    const after = await mailSnapshot(pool, accountId);
    assertUntouched(before, after, movesBefore, provider.moves.length, label);
    assert.equal(result.ok, false, `${label}: approval was accepted`);
    assert.equal(result.outboxId, undefined, `${label}: approval returned an outbox id`);
    const stored = await pool.query<{ status: string }>(
      "select status from seer.triage_proposals where id = $1",
      [proposalId],
    );
    assert.equal(stored.rows[0].status, "pending", `${label}: proposal left pending`);
  }

  await check("unbound approve ignores a swapped delete", async () => {
    const { shown } = await propose({
      providerId: "pc-unbound-shown",
      subject: "40% off",
      action: "archive",
    });
    const victimId = await addConversation(pool, accountId, "pc-unbound-victim", "Wire");
    await retarget(pool, shown.id, {
      action: "delete",
      conversationId: victimId,
      providerConversationId: "pc-unbound-victim",
      subject: "Wire",
      destinationId: null,
      destinationName: null,
    });
    await expectRefusal(
      "unbound approve",
      shown.id,
      unboundApproval(shown.id),
      "unbound-swap-delete",
    );
  });

  await check("bound approve refuses a swapped trash of another conversation", async () => {
    const { shown } = await propose({
      providerId: "pc-bound-shown",
      subject: "40% off",
      action: "archive",
    });
    const victimId = await addConversation(pool, accountId, "pc-bound-victim", "Wire");
    await retarget(pool, shown.id, {
      action: "delete",
      conversationId: victimId,
      providerConversationId: "pc-bound-victim",
      subject: "Wire",
      destinationId: null,
      destinationName: null,
    });
    await expectRefusal(
      "archive shown, delete stored",
      shown.id,
      boundApproval(shown.id, bindingOf(shown)),
      "bound-swap-delete",
    );
  });

  await check("bound approve refuses a swapped archive of another conversation", async () => {
    const { shown } = await propose({
      providerId: "pc-archive-shown",
      subject: "Newsletter",
      action: "archive",
    });
    const victimId = await addConversation(pool, accountId, "pc-archive-victim", "Contract");
    await retarget(pool, shown.id, {
      action: "archive",
      conversationId: victimId,
      providerConversationId: "pc-archive-victim",
      subject: "Contract",
      destinationId: null,
      destinationName: null,
    });
    await expectRefusal(
      "archive retargeted",
      shown.id,
      boundApproval(shown.id, bindingOf(shown)),
      "bound-swap-archive",
    );
  });

  await check("bound approve refuses a provider-conversation retarget", async () => {
    const { shown } = await propose({
      providerId: "pc-provider-shown",
      subject: "Digest",
      action: "delete",
    });
    await addConversation(pool, accountId, "pc-provider-victim", "Payroll");
    await retarget(pool, shown.id, {
      action: "delete",
      conversationId: null,
      providerConversationId: "pc-provider-victim",
      subject: "Digest",
      destinationId: null,
      destinationName: null,
    });
    await expectRefusal(
      "provider conversation retargeted",
      shown.id,
      boundApproval(shown.id, bindingOf(shown)),
      "bound-swap-provider",
    );
  });

  await check("bound approve refuses a file move to another folder", async () => {
    const { shown } = await propose({
      providerId: "pc-file-shown",
      subject: "Vendor blast",
      action: "file",
      destinationId: "folder-newsletters",
      destinationName: "Newsletters",
    });
    await retarget(pool, shown.id, {
      action: "file",
      conversationId: shown.conversationId,
      providerConversationId: shown.providerConversationId,
      subject: shown.subject,
      destinationId: "folder-secret",
      destinationName: "Newsletters",
    });
    await expectRefusal(
      "file destination swapped",
      shown.id,
      boundApproval(shown.id, bindingOf(shown)),
      "bound-swap-file",
    );
  });

  await check("bound approve refuses a filtered move of another conversation", async () => {
    const { shown } = await propose({
      providerId: "pc-filter-shown",
      subject: "List mail",
      action: "filtered",
      destinationId: "folder-bulk",
      destinationName: "Bulk",
    });
    const victimId = await addConversation(pool, accountId, "pc-filter-victim", "Board pack");
    await retarget(pool, shown.id, {
      action: "filtered",
      conversationId: victimId,
      providerConversationId: "pc-filter-victim",
      subject: "Board pack",
      destinationId: "folder-exec",
      destinationName: "Exec",
    });
    await expectRefusal(
      "filtered retargeted",
      shown.id,
      boundApproval(shown.id, bindingOf(shown)),
      "bound-swap-filtered",
    );
  });

  await check("bound approve refuses a keep proposal rewritten as delete", async () => {
    const { shown } = await propose({
      providerId: "pc-keep-shown",
      subject: "From a person",
      action: "keep",
    });
    const victimId = await addConversation(pool, accountId, "pc-keep-victim", "Taxes");
    await retarget(pool, shown.id, {
      action: "delete",
      conversationId: victimId,
      providerConversationId: "pc-keep-victim",
      subject: "Taxes",
      destinationId: null,
      destinationName: null,
    });
    await expectRefusal(
      "keep rewritten as delete",
      shown.id,
      boundApproval(shown.id, bindingOf(shown)),
      "bound-swap-keep",
    );
  });

  await check("bound approve refuses a subject swap of the same conversation", async () => {
    const { shown } = await propose({
      providerId: "pc-subject-shown",
      subject: "40% off",
      action: "archive",
    });
    await retarget(pool, shown.id, {
      action: "archive",
      conversationId: shown.conversationId,
      providerConversationId: shown.providerConversationId,
      subject: "Please pay this invoice",
      destinationId: null,
      destinationName: null,
    });
    await expectRefusal(
      "subject swapped",
      shown.id,
      boundApproval(shown.id, bindingOf(shown)),
      "bound-swap-subject",
    );
  });

  await check("matching approve still archives the conversation that was shown", async () => {
    const { shown, conversationId } = await propose({
      providerId: "pc-happy-shown",
      subject: "40% off",
      action: "archive",
    });
    const beforeMoves = provider.moves.length;
    const result = await approve(
      accountId,
      boundApproval(shown.id, bindingOf(shown)),
      "bound-happy-archive",
      provider,
    );
    assert.equal(result.ok, true, result.error);
    assert.equal(provider.moves.length, beforeMoves, "archive went to the provider directly");
    const outbox = await pool.query<{ command: { type: string; conversationId: string } }>(
      "select command from seer.outbox where id = $1",
      [result.outboxId],
    );
    assert.equal(outbox.rows[0].command.type, "archive");
    assert.equal(outbox.rows[0].command.conversationId, conversationId);
    const folders = await pool.query<{ folders: string[] }>(
      "select folders from seer.conversations where id = $1",
      [conversationId],
    );
    assert.ok(folders.rows[0].folders.includes("archive"));
    assert.ok(!folders.rows[0].folders.includes("inbox"));
  });

  await check("a later read of the proposal cannot change the approved mail", async () => {
    const { shown, conversationId } = await propose({
      providerId: "pc-race-shown",
      subject: "40% off",
      action: "archive",
    });
    const victimId = await addConversation(pool, accountId, "pc-race-victim", "Wire");
    const livePool = db();
    assert.equal(livePool, pool, "the command path uses the test pool");
    let swapped = 0;
    let reads = 0;
    const restore = swapBeforeLaterProposalReads(pool, async () => {
      swapped += 1;
      const client = await pool.connect();
      try {
        await client.query(
          `update seer.triage_proposals set
             action = 'delete',
             conversation_id = $2,
             provider_conversation_id = 'pc-race-victim',
             subject = 'Wire'
           where id = $1`,
          [shown.id, victimId],
        );
      } finally {
        client.release();
      }
    });
    let result;
    try {
      result = await approve(
        accountId,
        boundApproval(shown.id, bindingOf(shown)),
        "bound-second-read",
        provider,
      );
    } finally {
      reads = restore();
    }
    assert.ok(reads >= 1, "approval never read seer.triage_proposals");
    const victim = await pool.query<{ folders: string[] }>(
      "select folders from seer.conversations where id = $1",
      [victimId],
    );
    assert.deepEqual(
      [...victim.rows[0].folders].sort(),
      ["inbox"],
      "the conversation written between reads was trashed or archived",
    );
    const victimMail = await pool.query<{ n: number }>(
      `select count(*)::int as n from seer.outbox
        where account_id = $1 and command->>'conversationId' = $2`,
      [accountId, victimId],
    );
    assert.equal(victimMail.rows[0].n, 0, "outbox queued the conversation from the later read");
    const victimMoves = provider.moves.filter((move) => move.id === "pc-race-victim");
    assert.equal(victimMoves.length, 0, "provider moved the conversation from the later read");
    if (result.ok) {
      const outbox = await pool.query<{ command: { type: string; conversationId: string } }>(
        "select command from seer.outbox where id = $1",
        [result.outboxId],
      );
      assert.equal(outbox.rows[0].command.type, "archive");
      assert.equal(outbox.rows[0].command.conversationId, conversationId);
    } else {
      const shownFolders = await pool.query<{ folders: string[] }>(
        "select folders from seer.conversations where id = $1",
        [conversationId],
      );
      assert.deepEqual([...shownFolders.rows[0].folders].sort(), ["inbox"]);
      assert.equal(result.outboxId, undefined);
    }
  });
} finally {
  await database.stop();
}

async function installBrowser(): Promise<Window> {
  const { JSDOM } = await import("jsdom");
  const dom = new JSDOM("<!doctype html><html><body><div id='root'></div></body></html>", {
    url: "http://localhost/",
    pretendToBeVisual: true,
  });
  const { window } = dom;
  const globals = globalThis as unknown as Record<string, unknown>;
  globals.window = window;
  globals.document = window.document;
  Object.defineProperty(globals, "navigator", {
    value: window.navigator,
    configurable: true,
  });
  globals.HTMLElement = window.HTMLElement;
  globals.Element = window.Element;
  globals.Node = window.Node;
  globals.MouseEvent = window.MouseEvent;
  globals.KeyboardEvent = window.KeyboardEvent;
  globals.Event = window.Event;
  globals.IS_REACT_ACT_ENVIRONMENT = true;
  if (!window.matchMedia) {
    window.matchMedia = ((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener() {},
      removeListener() {},
      addEventListener() {},
      removeEventListener() {},
      dispatchEvent() {
        return false;
      },
    })) as unknown as typeof window.matchMedia;
  }
  return window;
}

const shownProposalCard = {
  id: "22222222-2222-4222-8222-222222222222",
  botId: "b1",
  botSlug: "chief-of-staff",
  botName: "Chief of staff",
  conversationId: "33333333-3333-4333-8333-333333333333",
  providerConversationId: "pc-shown",
  senderEmail: "deals@shop.test",
  subject: "40% off",
  action: "archive" as const,
  destinationId: "folder-newsletters",
  destinationName: "Newsletters",
  rationale: "Low value",
  status: "pending" as const,
  lastError: null,
  outboxId: null,
  createdAt: "2026-10-16T12:00:00.000Z",
  decidedAt: null,
};

function staffFixture() {
  return {
    asOf: "2026-10-16T12:00:00.000Z",
    bots: [{ id: "b1", slug: "chief-of-staff", displayName: "Chief of staff" }],
    tasks: [],
    proposals: [shownProposalCard],
    generalMessages: [],
    taskMessages: [],
  };
}

async function renderStaffBoardClick(): Promise<void> {
  const window = await installBrowser();
  const proposal = shownProposalCard;
  const { createElement, act } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { StaffBoard } = await import("../src/components/v2/StaffBoard.tsx");
  const boardClicks: unknown[][] = [];
  const boardRoot = window.document.createElement("div");
  window.document.body.appendChild(boardRoot);
  const board = createRoot(boardRoot);
  await act(async () => {
    board.render(
      createElement(StaffBoard, {
        view: staffFixture(),
        onDecideProposal: (...args: unknown[]) => {
          boardClicks.push(args);
        },
      }),
    );
  });
  const boardButton = [...boardRoot.querySelectorAll("button")].find(
    (button) => button.textContent === "Approve",
  );
  assert.ok(boardButton, "StaffBoard rendered Approve");
  await act(async () => {
    boardButton.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  });
  const shownFields = fieldsFromClick(boardClicks[0] ?? []);
  assert.equal(shownFields.proposalId ?? boardClicks[0]?.[0], proposal.id);
  assert.equal(shownFields.decision ?? boardClicks[0]?.[1], "approved");
  assert.equal(shownFields.action, proposal.action, "Approve did not send the action on screen");
  assert.equal(
    shownFields.conversationId,
    proposal.conversationId,
    "Approve did not send the conversation on screen",
  );
  assert.equal(shownFields.subject, proposal.subject, "Approve did not send the subject on screen");
  assert.equal(
    shownFields.destinationId,
    proposal.destinationId,
    "Approve did not send the destination on screen",
  );
  assert.equal(
    shownFields.providerConversationId,
    proposal.providerConversationId,
    "Approve did not send the provider conversation on screen",
  );
  board.unmount();
}

async function renderMailClientApproval(): Promise<void> {
  const window = await installBrowser();
  const proposal = shownProposalCard;
  const posted: Array<{ command?: Record<string, unknown>; idempotencyKey?: string }> = [];
  const { sampleView } = await import("../src/app/dev/preview/sample.ts");
  const mailbox = {
    accountId: "acct-1",
    folder: "inbox" as const,
    sort: "date" as const,
    rows: [],
    total: 0,
    needsYou: 0,
    nextCursor: null,
  };
  const respond = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  const fakeFetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url.includes("/api/v2/commands")) {
      posted.push(JSON.parse(String(init?.body ?? "{}")));
      return respond({ result: { ok: true, replayed: false } });
    }
    if (url.includes("/api/v2/staff")) return respond({ view: staffFixture() });
    if (url.includes("/api/v2/inbox")) return respond({ view: sampleView });
    if (url.includes("/api/v3/accounts")) return respond({ active: { id: "acct-1" } });
    if (url.includes("/api/v3/mailbox")) return respond({ view: mailbox });
    return respond({});
  };
  const globals = globalThis as unknown as Record<string, unknown>;
  globals.fetch = fakeFetch;
  window.fetch = fakeFetch as typeof window.fetch;

  const { createElement, act } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { MailClient } = await import("../src/components/v3/MailClient.tsx");
  const rootElement = window.document.getElementById("root");
  assert.ok(rootElement);
  const root = createRoot(rootElement);
  await act(async () => {
    root.render(createElement(MailClient, {}));
  });
  const atlas = await waitForButton(window, "Atlas");
  await act(async () => {
    atlas.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  });
  const approve = await waitForButton(window, "Approve");
  await act(async () => {
    approve.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 30));
  });
  root.unmount();

  assert.equal(posted.length, 1, "clicking Approve did not post a command");
  const command = posted[0].command ?? {};
  assert.equal(typeof posted[0].idempotencyKey, "string");
  assert.equal(command.type, "decideTriageProposal");
  assert.equal(command.decision, "approved");
  assert.equal(command.proposalId, proposal.id);
  assert.equal(command.action, proposal.action, "the posted command omitted the action on screen");
  assert.equal(
    command.conversationId,
    proposal.conversationId,
    "the posted command omitted the conversation on screen",
  );
  assert.equal(command.providerConversationId, proposal.providerConversationId);
  assert.equal(command.subject, proposal.subject, "the posted command omitted the subject on screen");
  assert.equal(
    command.destinationId,
    proposal.destinationId,
    "the posted command omitted the destination on screen",
  );
}

function fieldsFromClick(args: unknown[]): Record<string, unknown> {
  const fields: Record<string, unknown> = {};
  for (const arg of args) {
    if (!arg || typeof arg !== "object") continue;
    const record = arg as Record<string, unknown>;
    if (
      "action" in record ||
      "conversationId" in record ||
      "subject" in record ||
      "destinationId" in record ||
      "providerConversationId" in record
    ) {
      Object.assign(fields, record);
    }
  }
  if (typeof args[0] === "string") fields.proposalId ??= args[0];
  if (args[1] === "approved" || args[1] === "rejected") fields.decision ??= args[1];
  return fields;
}

async function waitForButton(window: Window, label: string): Promise<HTMLButtonElement> {
  const start = Date.now();
  while (Date.now() - start < 4000) {
    const found = [...window.document.querySelectorAll("button")].find(
      (button) => button.textContent?.trim() === label,
    );
    if (found) return found;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`timed out waiting for ${label}`);
}

await check("StaffBoard Approve carries the proposal on screen", async () => {
  await renderStaffBoardClick();
});

await check("MailClient posts the proposal that was on screen", async () => {
  await renderMailClientApproval();
});

if (failures.length > 0) {
  throw new Error(`${failures.length} approval-binding test(s) failed:\n${failures.join("\n")}`);
}
console.log("v2-triage-approval-binding: OK");
