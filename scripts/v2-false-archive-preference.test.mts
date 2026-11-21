/**
 * A mailbox archive or trash of a conversation the model still has filed as a
 * matter must not become an explicit per-sender placement, and it must not be
 * attributed to the newest inbound From. That address is whatever the provider
 * stored from the message header.
 *
 * These assertions describe the safe behavior. They fail while a completed
 * archive/trash outbox row is still copied onto that sender and a later
 * qualifying thread from the same address is kept out of Atlas.
 */
import assert from "node:assert/strict";
import type { Pool } from "pg";
import { startTestDb } from "./v2-testdb.mts";
import { upsertAccount, upsertUser } from "../src/lib/v2/db/accounts.ts";
import { asConversationId, type AccountId } from "../src/lib/v2/db/types.ts";
import { saveDecision, currentDecision } from "../src/lib/v2/intelligence/repository.ts";
import { clearContextInputCache, loadContextInput } from "../src/lib/v2/intelligence/context-loader.ts";
import { readBatch } from "../src/lib/v2/intelligence/read-batch.ts";
import type { ReaderModel } from "../src/lib/v2/intelligence/reader.ts";
import { executeCommand } from "../src/lib/v2/commands/execute.ts";
import { insertProposal } from "../src/lib/v2/staff/repository.ts";
import { drainOutbox } from "../src/lib/v3/outbox/drain.ts";
import { syncFolder } from "../src/lib/v2/sync/engine.ts";
import { GmailProvider } from "../src/lib/v2/providers/gmail.ts";
import { OutlookProvider } from "../src/lib/v2/providers/outlook.ts";
import type { MailProvider } from "../src/lib/v2/providers/types.ts";

const OWNER = "owner@desk.example";
const LATER_BODY =
  "The revised delivery schedule is ready. Please send the updated dates by Friday.";

type Poison = {
  threadId: string;
  laterId: string;
  poisoned: string;
  /** Address on the earlier message, and on a staff proposal when there is one. */
  shown: string;
  kind: "archive" | "trash" | "staff-archive" | "staff-delete" | "staff-filtered";
};

const gmailPoisons: Poison[] = [
  {
    threadId: "g-archive",
    laterId: "g-later-archive",
    poisoned: "client.pat@vendor.example",
    shown: "real.counterparty@vendor.example",
    kind: "archive",
  },
  {
    threadId: "g-trash",
    laterId: "g-later-trash",
    poisoned: "colleague.trash@desk.example",
    shown: "real.counterparty@vendor.example",
    kind: "trash",
  },
  {
    threadId: "g-staff-archive",
    laterId: "g-later-staff-archive",
    poisoned: "colleague.staff.archive@desk.example",
    shown: "real.counterparty@vendor.example",
    kind: "staff-archive",
  },
  {
    threadId: "g-staff-delete",
    laterId: "g-later-staff-delete",
    poisoned: "colleague.staff.delete@desk.example",
    shown: "real.counterparty@vendor.example",
    kind: "staff-delete",
  },
  {
    threadId: "g-staff-filtered",
    laterId: "g-later-staff-filtered",
    poisoned: "colleague.staff.filtered@desk.example",
    shown: "real.counterparty@vendor.example",
    kind: "staff-filtered",
  },
];

const outlookPoison: Poison = {
  threadId: "o-archive",
  laterId: "o-later-archive",
  poisoned: "colleague.outlook@desk.example",
  shown: "real.counterparty@vendor.example",
  kind: "archive",
};

function b64url(value: string): string {
  return Buffer.from(value, "utf8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function gmailMessage(
  threadId: string,
  id: string,
  epochMs: number,
  from: string,
  subject: string,
  body: string,
) {
  return {
    id,
    threadId,
    snippet: body,
    labelIds: ["INBOX"],
    internalDate: String(epochMs),
    payload: {
      headers: [
        { name: "From", value: from },
        { name: "To", value: `Owner <${OWNER}>` },
        { name: "Subject", value: subject },
      ],
      mimeType: "text/plain",
      body: { size: body.length, data: b64url(body) },
    },
  };
}

function gmailThread(poison: Poison) {
  const subject = `Matter ${poison.threadId}`;
  return {
    id: poison.threadId,
    messages: [
      gmailMessage(
        poison.threadId,
        `${poison.threadId}-early`,
        1_700_000_000_000,
        `Real Counterparty <${poison.shown}>`,
        subject,
        "The original note on this matter.",
      ),
      gmailMessage(
        poison.threadId,
        `${poison.threadId}-poison`,
        1_700_000_100_000,
        `Injected Sender <${poison.poisoned}>`,
        subject,
        "A later note arrived on this same thread.",
      ),
      gmailMessage(
        poison.threadId,
        `${poison.threadId}-owner`,
        1_700_000_200_000,
        `Owner <${OWNER}>`,
        subject,
        "Filing this away.",
      ),
    ],
  };
}

function gmailLater(id: string, from: string) {
  const subject = `Follow up ${id}`;
  const body = LATER_BODY;
  return {
    id,
    messages: [
      gmailMessage(id, `${id}-m1`, 1_700_100_000_000, `Sender <${from}>`, subject, body),
    ],
  };
}

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function gmailProvider(threads: Map<string, { id: string; messages: unknown[] }>, inbox: () => string[]) {
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    const href = String(url);
    if (method === "GET" && href.includes("/threads?")) {
      const query = new URL(href).searchParams.get("q") ?? "";
      assert.equal(query, "in:inbox");
      const ids = inbox();
      return json({
        threads: ids.map((id) => ({ id })),
        resultSizeEstimate: ids.length,
      });
    }
    const threadGet = href.match(/\/threads\/([^?]+)\?format=(?:full|minimal)/);
    if (method === "GET" && threadGet) {
      const id = decodeURIComponent(threadGet[1]);
      const thread = threads.get(id);
      assert.ok(thread, `missing gmail thread ${id}`);
      return json(thread);
    }
    if (method === "POST" && /\/messages\/[^/]+\/(?:modify|trash)$/.test(href)) {
      return json({ id: "mutated" });
    }
    throw new Error(`unexpected gmail request ${method} ${href}`);
  }) as typeof fetch;

  return new GmailProvider({
    accessToken: "placeholder-access-token",
    accountEmail: OWNER,
    fetchImpl,
    pageSize: 20,
  });
}

type GraphMessage = {
  id: string;
  conversationId: string;
  subject: string;
  from: { emailAddress: { address: string; name: string } };
  toRecipients: { emailAddress: { address: string; name: string } }[];
  ccRecipients: [];
  receivedDateTime: string;
  bodyPreview: string;
  body: { contentType: string; content: string };
  isRead: boolean;
  parentFolderId: string;
};

function graphMessage(
  conversationId: string,
  id: string,
  received: string,
  from: string,
  subject: string,
  body: string,
): GraphMessage {
  return {
    id,
    conversationId,
    subject,
    from: { emailAddress: { address: from, name: "Sender" } },
    toRecipients: [{ emailAddress: { address: OWNER, name: "Owner" } }],
    ccRecipients: [],
    receivedDateTime: received,
    bodyPreview: body,
    body: { contentType: "text", content: body },
    isRead: true,
    parentFolderId: "inbox",
  };
}

function outlookThreads(poison: Poison): Map<string, GraphMessage[]> {
  const subject = `Matter ${poison.threadId}`;
  const threads = new Map<string, GraphMessage[]>();
  threads.set(poison.threadId, [
    graphMessage(
      poison.threadId,
      `${poison.threadId}-early`,
      "2026-03-01T10:00:00Z",
      poison.shown,
      subject,
      "The original note on this matter.",
    ),
    graphMessage(
      poison.threadId,
      `${poison.threadId}-poison`,
      "2026-03-02T10:00:00Z",
      poison.poisoned,
      subject,
      "A later note arrived on this same thread.",
    ),
    graphMessage(
      poison.threadId,
      `${poison.threadId}-owner`,
      "2026-03-03T10:00:00Z",
      OWNER,
      subject,
      "Filing this away.",
    ),
  ]);
  threads.set(poison.laterId, [
    graphMessage(
      poison.laterId,
      `${poison.laterId}-m1`,
      "2026-04-01T10:00:00Z",
      poison.poisoned,
      `Follow up ${poison.laterId}`,
      LATER_BODY,
    ),
  ]);
  threads.set("o-control", [
    graphMessage(
      "o-control",
      "o-control-m1",
      "2026-04-02T10:00:00Z",
      "colleague.outlook.control@desk.example",
      "Follow up o-control",
      LATER_BODY,
    ),
  ]);
  return threads;
}

function outlookProvider(threads: Map<string, GraphMessage[]>, inbox: () => string[]) {
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    const href = String(url);
    if (method === "GET" && href.includes("/mailFolders/inbox/messages")) {
      const ids = inbox();
      return json({
        value: ids.map((id) => threads.get(id)?.[0]).filter(Boolean),
        "@odata.count": ids.length,
      });
    }
    if (method === "GET" && href.includes("conversationId")) {
      const decoded = decodeURIComponent(href);
      const id = decoded.match(/conversationId eq '([^']+)'/)?.[1];
      assert.ok(id, `outlook filter missing conversation id: ${decoded}`);
      return json({ value: threads.get(id) ?? [] });
    }
    if (method === "POST" && href.includes("/move")) {
      return json({ id: "moved" });
    }
    throw new Error(`unexpected outlook request ${method} ${href}`);
  }) as typeof fetch;

  return new OutlookProvider({
    accessToken: "placeholder-access-token",
    accountEmail: OWNER,
    fetchImpl,
    pageSize: 20,
  });
}

async function corpusId(pool: Pool, accountId: AccountId, providerId: string): Promise<string> {
  const row = await pool.query<{ id: string }>(
    `select id from seer.conversations
      where account_id = $1 and provider_conversation_id = $2`,
    [accountId, providerId],
  );
  assert.equal(row.rowCount, 1, `conversation ${providerId} was not stored`);
  return row.rows[0].id;
}

async function fileAsModelMatter(accountId: AccountId, conversationId: string): Promise<void> {
  await saveDecision({
    accountId,
    conversationId: asConversationId(conversationId),
    home: "matter",
    proposedHome: "matter",
    summary: "Live client work",
    rationale: "Model filed this as a matter",
    owner: "you",
    ask: "Keep the original file moving",
    vetoReasons: [],
    yields: [],
    evidence: [],
  });
}

async function act(
  accountId: AccountId,
  poison: Poison,
  conversationId: string,
): Promise<void> {
  if (poison.kind === "archive") {
    const result = await executeCommand(
      { accountId },
      { type: "archive", conversationId },
      `archive-${poison.threadId}`,
    );
    assert.equal(result.ok, true, result.error);
    return;
  }
  if (poison.kind === "trash") {
    const result = await executeCommand(
      { accountId },
      { type: "delete", conversationId, byUser: true },
      `trash-${poison.threadId}`,
    );
    assert.equal(result.ok, true, result.error);
    return;
  }
  const action =
    poison.kind === "staff-delete"
      ? "delete"
      : poison.kind === "staff-filtered"
        ? "filtered"
        : "archive";
  const proposal = await insertProposal({
    accountId,
    conversationId,
    providerConversationId: poison.threadId,
    senderEmail: poison.shown,
    subject: `Matter ${poison.threadId}`,
    action,
  });
  const result = await executeCommand(
    { accountId },
    { type: "decideTriageProposal", proposalId: proposal.id, decision: "approved" },
    `staff-${poison.threadId}`,
  );
  assert.equal(result.ok, true, result.error);
}

const qualifyingRead: ReaderModel = async (input) => ({
  home: "matter",
  summary: "Direct request for updated dates",
  rationale: "The sender asked the mailbox owner for the revised dates",
  owner: "you",
  ask: "Send the updated dates",
  obligation: false,
  matterRef: input.conversation.subject,
  yields: [],
  evidence: [],
});

async function runProviderCase(input: {
  pool: Pool;
  accountId: AccountId;
  provider: MailProvider;
  poisons: Poison[];
  controlId: string;
  sync(ids: string[]): Promise<void>;
}): Promise<string[]> {
  const { pool, accountId, provider, poisons } = input;
  await input.sync(poisons.map((item) => item.threadId));

  const sourceIds = new Map<string, string>();
  for (const poison of poisons) {
    const id = await corpusId(pool, accountId, poison.threadId);
    sourceIds.set(poison.threadId, id);
    const newestInbound = await pool.query<{ from_email: string; is_outgoing: boolean }>(
      `select from_email, is_outgoing
         from seer.messages
        where conversation_id = $1 and is_outgoing = false
        order by sent_at desc nulls last
        limit 1`,
      [id],
    );
    assert.equal(newestInbound.rows[0]?.from_email, poison.poisoned);
    assert.equal(newestInbound.rows[0]?.is_outgoing, false);
    await fileAsModelMatter(accountId, id);
    await act(accountId, poison, id);
  }

  const drained = await drainOutbox(accountId, provider);
  if (drained.done !== poisons.length) {
    const outbox = await pool.query(
      `select status, last_error, command->>'type' as type
         from seer.outbox where account_id = $1`,
      [accountId],
    );
    assert.equal(
      drained.done,
      poisons.length,
      `outbox drain did not finish: ${JSON.stringify(outbox.rows)}`,
    );
  }

  for (const poison of poisons) {
    const decision = await currentDecision(
      accountId,
      asConversationId(sourceIds.get(poison.threadId)!),
    );
    assert.equal(decision?.home, "matter");
    assert.notEqual(decision?.modelVersion, "user-correction");
  }

  await input.sync([
    ...poisons.map((item) => item.laterId),
    input.controlId,
  ]);

  await pool.query(
    `insert into seer.people (account_id, email, tier, vip)
     values ($1, 'client.pat@vendor.example', 'known', false)
     on conflict (account_id, email) do update set tier = 'known'`,
    [accountId],
  );

  clearContextInputCache();
  const context = await loadContextInput(accountId, OWNER);
  const contexts = new Map<string, string>();
  const batch = await readBatch(accountId, OWNER, async (read) => {
    contexts.set(String(read.conversationId), read.contextText);
    return qualifyingRead(read);
  });
  assert.equal(batch.failed, 0, "later threads should be readable");
  assert.equal(batch.decided, poisons.length + 1);

  const control = await currentDecision(
    accountId,
    asConversationId(await corpusId(pool, accountId, input.controlId)),
  );
  assert.equal(
    control?.home,
    "matter",
    `control promotion failed: ${control?.vetoReasons?.join(",")}`,
  );

  const problems: string[] = [];
  const rejectionPlacements = (context.placements ?? []).filter(
    (item) => item.home === "record" || item.home === "delete",
  );
  for (const poison of poisons) {
    const hit = rejectionPlacements.find((item) => item.senderEmail === poison.poisoned);
    if (hit) {
      problems.push(
        `${poison.kind} stored ${hit.home} x${hit.count} against ${poison.poisoned}`,
      );
    }
    const later = await currentDecision(
      accountId,
      asConversationId(await corpusId(pool, accountId, poison.laterId)),
    );
    const seen = contexts.get(await corpusId(pool, accountId, poison.laterId)) ?? "";
    if (later?.home !== "matter") {
      problems.push(
        `${poison.kind} later mail from ${poison.poisoned} landed in ${later?.home} (${(later?.vetoReasons ?? []).join(",")})`,
      );
    }
    if ((later?.vetoReasons ?? []).includes("prior_triage_rejection")) {
      problems.push(`${poison.kind} vetoed promotion with prior_triage_rejection`);
    }
    if (seen.includes(poison.poisoned) && /\[explicit\] for this exact sender/.test(seen)) {
      problems.push(
        `${poison.kind} described ${poison.poisoned} to the reader as prior placement feedback`,
      );
    }
  }
  return problems;
}

const db = await startTestDb();
try {
  const userId = await upsertUser(OWNER);

  const gmailAccount = await upsertAccount({
    userId,
    provider: "google",
    email: OWNER,
  });
  const gmailThreads = new Map<string, { id: string; messages: unknown[] }>();
  for (const poison of gmailPoisons) {
    gmailThreads.set(poison.threadId, gmailThread(poison));
    gmailThreads.set(poison.laterId, gmailLater(poison.laterId, poison.poisoned));
  }
  gmailThreads.set("g-control", gmailLater("g-control", "colleague.control@desk.example"));
  let gmailInbox: string[] = [];
  const gmail = gmailProvider(gmailThreads, () => gmailInbox);
  const gmailProblems = await runProviderCase({
    pool: db.pool,
    accountId: gmailAccount,
    provider: gmail,
    poisons: gmailPoisons,
    controlId: "g-control",
    async sync(ids) {
      gmailInbox = ids;
      const run = await syncFolder(gmailAccount, gmail, "inbox", "incremental");
      assert.ok(run.pages >= 1, "gmail sync produced no page");
    },
  });

  const outlookAccount = await upsertAccount({
    userId,
    provider: "microsoft",
    email: OWNER,
  });
  const outlookMessages = outlookThreads(outlookPoison);
  let outlookInbox: string[] = [];
  const outlook = outlookProvider(outlookMessages, () => outlookInbox);
  const outlookProblems = await runProviderCase({
    pool: db.pool,
    accountId: outlookAccount,
    provider: outlook,
    poisons: [outlookPoison],
    controlId: "o-control",
    async sync(ids) {
      outlookInbox = ids;
      const run = await syncFolder(outlookAccount, outlook, "inbox", "incremental");
      assert.ok(run.pages >= 1, "outlook sync produced no page");
    },
  });

  assert.deepEqual([...gmailProblems, ...outlookProblems], []);
  console.log("v2-false-archive-preference: OK");
} finally {
  await db.stop();
}
