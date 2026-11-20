/**
 * Gate: a mailbox read that has used up its hop must not keep filing.
 *
 * The scheduled read claims a five-minute lease and gives the conversation
 * read 250 seconds. Filing is a separate model pass. These tests are the
 * behavior that pass is supposed to have: once the hop deadline has passed,
 * no further filing model call starts, and a second hop can be the only
 * writer of section assignments. They fail while filing ignores the deadline.
 *
 * The model provider stands in for the remote gateway only. generateText,
 * output parsing, section writes, usage rows, and the lease SQL are the
 * product code.
 */
import assert from "node:assert/strict";
import { startTestDb, type TestDb } from "./v2-testdb.mts";
import { upsertAccount, upsertUser } from "../src/lib/v2/db/accounts.ts";
import type { AccountId } from "../src/lib/v2/db/types.ts";
import { FakeProvider } from "../src/lib/v2/providers/fake.ts";
import type { Message } from "../src/lib/v2/providers/types.ts";
import { syncFolder } from "../src/lib/v2/sync/engine.ts";
import { loadContextInput } from "../src/lib/v2/intelligence/context-loader.ts";
import {
  readConversation,
  type ReaderModel,
} from "../src/lib/v2/intelligence/reader.ts";
import type { ReadResult } from "../src/lib/v2/intelligence/schema.ts";
import { conversationsNeedingFiling } from "../src/lib/v2/intelligence/functions.ts";
import { runReadAccount } from "../src/lib/v2/intelligence/read-tick.ts";
import { READ_TICK_MS } from "../src/lib/v2/intelligence/read-tick.ts";
import { GET } from "../src/app/api/v2/read/route.ts";

type FilingCall = {
  startedAt: number;
  deadlineMs: number;
  section: string;
  ids: string[];
  signal: AbortSignal | undefined;
};

type HoldMode = "none" | "first" | "all";

const realNow = Date.now;
let clockShift = 0;
let captureDeadline = false;
let capturedDeadline = 0;
const filingCalls: FilingCall[] = [];
const releases: Array<() => void> = [];
let holdMode: HoldMode = "none";
let filingSection = "finance (ar/ap)";
let activeDeadline = 0;
let readerCalls = 0;
let shiftOnRead = false;

Date.now = () => {
  const now = realNow() + clockShift;
  if (captureDeadline) {
    capturedDeadline = now + READ_TICK_MS;
    captureDeadline = false;
  }
  return now;
};

function promptBlob(options: { prompt: unknown }): string {
  return JSON.stringify(options.prompt);
}

function classify(blob: string): "read" | "filing" | "naming" | "other" {
  if (blob.includes("You file an executive")) return "filing";
  if (blob.includes("Name the active work board")) return "naming";
  if (blob.includes("You are a chief of staff")) return "read";
  return "other";
}

function idsIn(blob: string): string[] {
  // generateText hands the model a message array. JSON.stringify escapes the
  // user payload, so item ids appear as \"id\":\"…\".
  return [
    ...new Set(
      [...blob.matchAll(/\\?"id\\?"\s*:\s*\\?"([0-9a-f-]{36})\\?"/gi)].map(
        (match) => match[1],
      ),
    ),
  ];
}

function usage() {
  return {
    inputTokens: { total: 12, noCache: 12, cacheRead: 0, cacheWrite: 0 },
    outputTokens: { total: 8, text: 8, reasoning: 0 },
  };
}

function textResult(text: string) {
  return {
    content: [{ type: "text" as const, text }],
    finishReason: { unified: "stop" as const, raw: "stop" },
    usage: usage(),
    warnings: [],
  };
}

function hold(): Promise<void> {
  return new Promise((resolve) => {
    releases.push(resolve);
  });
}

function releaseFiling(): void {
  const pending = releases.splice(0, releases.length);
  for (const resolve of pending) resolve();
}

function releaseNextFiling(): void {
  const next = releases.shift();
  if (next) next();
}

globalThis.AI_SDK_DEFAULT_PROVIDER = {
  specificationVersion: "v4" as const,
  languageModel(modelId: string) {
    return {
      specificationVersion: "v4" as const,
      provider: "test",
      modelId,
      supportedUrls: {},
      async doGenerate(options: {
        prompt: unknown;
        abortSignal?: AbortSignal;
      }) {
        const blob = promptBlob(options);
        const kind = classify(blob);
        if (kind === "read") {
          readerCalls += 1;
          if (shiftOnRead) clockShift += READ_TICK_MS + 5_000;
          throw new Error("reader observed the hop deadline");
        }
        if (kind !== "filing" && kind !== "naming") {
          throw new Error(`unclassified model prompt: ${blob.slice(0, 400)}`);
        }
        const startedAt = Date.now();
        const ids = idsIn(blob);
        if (kind === "filing") {
          const section = filingSection;
          filingCalls.push({
            startedAt,
            deadlineMs: activeDeadline,
            section,
            ids,
            signal: options.abortSignal,
          });
          if (ids.length === 0) {
            const marker = blob.indexOf("items");
            throw new Error(
              `filing prompt had no item ids around ${marker}: ${blob.slice(
                Math.max(0, marker - 80),
                marker + 400,
              )}`,
            );
          }
          const shouldHold =
            holdMode === "all" || (holdMode === "first" && filingCalls.length === 1);
          if (shouldHold) await hold();
          if (options.abortSignal?.aborted) {
            throw options.abortSignal.reason ?? new Error("aborted");
          }
          return textResult(
            JSON.stringify({
              filings: ids.map((id) => ({
                id,
                functionName: section,
              })),
            }),
          );
        }
        filingCalls.push({
          startedAt,
          deadlineMs: activeDeadline,
          section: "naming",
          ids,
          signal: options.abortSignal,
        });
        return textResult(
          JSON.stringify({
            matters: ids.map((id) => ({
              id,
              shortTitle: "Vendor customs release",
            })),
          }),
        );
      },
      async doStream() {
        throw new Error("filing uses generateText, not a stream");
      },
    };
  },
};

function outsiderMessage(
  id: string,
  from: string,
  to: string,
  body: string,
): Message & { folder: "inbox" } {
  return {
    providerMessageId: id,
    from: { email: from, name: "Alex Sender" },
    to: [{ email: to, name: "Desk" }],
    cc: [],
    sentAt: "2026-08-08T10:00:00Z",
    snippet: body.slice(0, 80),
    bodyHtml: `<p>${body}</p>`,
    bodyText: body,
    isUnread: true,
    isOutgoing: false,
    attachments: [],
    folder: "inbox",
  };
}

async function syncInbox(
  accountId: AccountId,
  owner: string,
  count: number,
  prefix: string,
): Promise<void> {
  const provider = new FakeProvider({
    conversations: Array.from({ length: count }, (_, index) => {
      const n = index + 1;
      const body = `Hi Desk, please approve the xylophone ${prefix} ${n} customs release.`;
      return {
        providerConversationId: `${prefix}-${n}`,
        subject: `Xylophone ${prefix} ${n} customs release`,
        messages: [
          outsiderMessage(
            `${prefix}-${n}-m`,
            `alex@xylophone${prefix}${n}.example`,
            owner,
            body,
          ),
        ],
      };
    }),
  });
  await syncFolder(accountId, provider, "inbox", "full");
}

const matterRead = (ref: string): ReadResult => ({
  home: "matter",
  summary: `Approve ${ref}`,
  rationale: "The sender asked for an approval",
  owner: "you",
  ask: "Please approve the customs release",
  obligation: true,
  matterRef: ref,
  yields: [],
  evidence: [],
});

const recordRead = (): ReadResult => ({
  home: "record",
  summary: "Receipt only",
  rationale: "Nothing is owed",
  owner: "nobody",
  ask: "nothing — informational",
  obligation: false,
  yields: [],
  evidence: [],
});

async function readStored(
  database: TestDb,
  accountId: AccountId,
  owner: string,
  prefix: string,
  home: "matter" | "record",
): Promise<number> {
  const rows = await database.pool.query<{ id: string; subject: string | null }>(
    `select id, subject from seer.conversations
      where account_id = $1 and provider_conversation_id like $2
      order by provider_conversation_id`,
    [accountId, `${prefix}-%`],
  );
  const context = await loadContextInput(accountId, owner);
  let read = 0;
  for (const row of rows.rows) {
    const loaded = await import("../src/lib/v2/intelligence/load-conversation.ts");
    const conversation = await loaded.loadConversation(row.id);
    assert.ok(conversation, "synced mail is readable");
    const ref = row.subject ?? `Xylophone ${prefix}`;
    const reader: ReaderModel = async () =>
      home === "matter" ? matterRead(ref) : recordRead();
    await readConversation({
      accountId,
      conversationId: row.id as never,
      conversation,
      context,
      model: reader,
    });
    read += 1;
  }
  return read;
}

async function matterSections(
  database: TestDb,
  accountId: AccountId,
): Promise<string[]> {
  const rows = await database.pool.query<{ function_name: string | null }>(
    `select function_name from seer.matters
      where account_id = $1
      order by title`,
    [accountId],
  );
  return rows.rows.map((row) => row.function_name ?? "");
}

async function filingUsageCount(
  database: TestDb,
  accountId: AccountId,
): Promise<number> {
  const rows = await database.pool.query<{ n: number }>(
    `select count(*)::int as n from seer.model_usage
      where account_id = $1 and escalation_reasons @> array['filing']::text[]`,
    [accountId],
  );
  return rows.rows[0]?.n ?? 0;
}

function lateCalls(deadlineMs: number): FilingCall[] {
  return filingCalls.filter((call) => call.startedAt > deadlineMs);
}

const database = await startTestDb();
const previousNodeEnv = process.env.NODE_ENV;
process.env.NODE_ENV = "test";
delete process.env.CRON_SECRET;

try {
  const failures: string[] = [];
  const owner = "desk@example.com";
  const userId = await upsertUser(owner);

  // --- Deadline passes between filing batches ---
  try {
    filingCalls.length = 0;
    releaseFiling();
    holdMode = "first";
    filingSection = "finance (ar/ap)";
    clockShift = 0;
    const accountId = await upsertAccount({
      userId,
      provider: "google",
      email: owner,
    });
    await syncInbox(accountId, owner, 41, "batch");
    await syncInbox(accountId, owner, 1, "loose");
    const matters = await readStored(database, accountId, owner, "batch", "matter");
    const loose = await readStored(database, accountId, owner, "loose", "record");
    assert.equal(matters, 41, "outsider mail became matters");
    assert.equal(loose, 1, "outsider mail became an unfiled conversation");
    const unfiledMatters = await database.pool.query<{ n: number }>(
      `select count(*)::int as n from seer.matters
        where account_id = $1 and function_name is null`,
      [accountId],
    );
    assert.equal(unfiledMatters.rows[0]?.n, 41);
    assert.equal((await conversationsNeedingFiling(accountId, 10)).length, 1);

    const deadlineMs = Date.now() + 1_500;
    activeDeadline = deadlineMs;
    const running = runReadAccount(
      {
        id: accountId,
        userId,
        provider: "google",
        email: owner,
        displayName: "Desk",
        status: "active",
      },
      {
        deadlineMs,
        model: async () => recordRead(),
        perAccountLimit: 400,
        concurrency: 1,
      },
    );
    const started = Date.now();
    while (filingCalls.length === 0) {
      if (Date.now() - started > 10_000) {
        throw new Error("filing never started while the hop deadline was still ahead");
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.ok(
      filingCalls[0].startedAt <= deadlineMs,
      "the first filing batch is the one that began before the deadline",
    );
    while (Date.now() <= deadlineMs) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    releaseFiling();
    await running;
    const late = lateCalls(deadlineMs);
    assert.equal(
      late.length,
      0,
      `filing kept starting model calls after the hop deadline: ${late
        .map((call) => call.section)
        .join(",")}`,
    );
    assert.ok(
      (await filingUsageCount(database, accountId)) <= 1,
      "only the batch that started before the deadline may record model usage",
    );
    const filed = await database.pool.query<{ n: number }>(
      `select count(*)::int as n from seer.matters
        where account_id = $1 and function_name is not null`,
      [accountId],
    );
    assert.ok(
      (filed.rows[0]?.n ?? 0) <= 40,
      "a batch that would start after the deadline must not assign sections",
    );
  } catch (error) {
    failures.push(error instanceof Error ? error.message : String(error));
  }

  // --- Overlapping hops after the read deadline ---
  try {
    filingCalls.length = 0;
    releaseFiling();
    holdMode = "all";
    readerCalls = 0;
    clockShift = 0;
    shiftOnRead = true;
    filingSection = "finance (ar/ap)";
    const overlapOwner = "overlap@example.com";
    const overlapUser = await upsertUser(overlapOwner);
    const accountId = await upsertAccount({
      userId: overlapUser,
      provider: "google",
      email: overlapOwner,
    });
    await syncInbox(accountId, overlapOwner, 2, "open");
    await readStored(database, accountId, overlapOwner, "open", "matter");
    await syncInbox(accountId, overlapOwner, 1, "live");
    const unread = await database.pool.query<{ n: number }>(
      `select count(*)::int as n from seer.conversations c
        where c.account_id = $1
          and c.provider_conversation_id like 'live-%'
          and not exists (
            select 1 from seer.conversation_decisions d
             where d.conversation_id = c.id and d.is_current
          )`,
      [accountId],
    );
    assert.equal(unread.rows[0]?.n, 1, "one outsider thread is still unread");

    captureDeadline = true;
    const hop1 = GET(
      new Request(`http://127.0.0.1/api/v2/read?accountId=${accountId}`),
    );
    const hop1Deadline = capturedDeadline;
    assert.ok(hop1Deadline > 0, "the route set a hop deadline");
    activeDeadline = hop1Deadline;

    const gateStarted = Date.now();
    while (filingCalls.length === 0 && readerCalls === 0) {
      if (Date.now() - gateStarted > 10_000) break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    const hop1State = await Promise.race([
      hop1.then(() => "returned" as const),
      new Promise<"filing">((resolve) => {
        const timer = setInterval(() => {
          if (filingCalls.some((call) => call.deadlineMs === hop1Deadline)) {
            clearInterval(timer);
            resolve("filing");
          }
        }, 20);
      }),
      new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), 10_000)),
    ]);

    if (hop1State === "filing") {
      await database.pool.query(
        `update seer.worker_leases
            set expires_at = now() - interval '1 second'
          where account_id = $1 and kind = 'read'`,
        [accountId],
      );
      shiftOnRead = false;
      filingSection = "hr";
      captureDeadline = true;
      const hop1Calls = filingCalls.length;
      const hop2 = GET(
        new Request(`http://127.0.0.1/api/v2/read?accountId=${accountId}`),
      );
      const hop2Deadline = capturedDeadline;
      activeDeadline = hop2Deadline;
      const hop2Started = Date.now();
      while (
        !filingCalls.some((call) => call.deadlineMs === hop2Deadline) &&
        Date.now() - hop2Started < 10_000
      ) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      const hop2Entered = filingCalls.some((call) => call.deadlineMs === hop2Deadline);
      if (!hop2Entered) {
        releaseFiling();
        const missed = await hop2
          .then(async (response) => ({
            status: response.status,
            body: await response.json(),
          }))
          .catch((error: unknown) =>
            error instanceof Error ? error.message : String(error),
          );
        await hop1.catch(() => undefined);
        assert.fail(`the next read did not file while the first hop was still filing: ${JSON.stringify(missed)}`);
      }
      releaseNextFiling();
      await hop1;
      const afterHop1 = await matterSections(database, accountId);
      releaseNextFiling();
      const hop2Response = await hop2;
      const hop2Body = (await hop2Response.json()) as {
        report?: Array<{ skipped?: string; filing?: unknown }>;
      };
      const afterHop2 = await matterSections(database, accountId);
      const usageRows = await filingUsageCount(database, accountId);
      const hop1Late = filingCalls
        .slice(0, hop1Calls)
        .filter((call) => call.startedAt > hop1Deadline);
      assert.equal(
        hop1Late.length,
        0,
        `hop 1 kept filing after its deadline while hop 2 held the lease (hop2Entered=${hop2Entered}, filingUsage=${usageRows}, hop2=${JSON.stringify(
          hop2Body,
        )}, afterHop1=${afterHop1.join("|")}, afterHop2=${afterHop2.join("|")})`,
      );
      assert.deepEqual(
        afterHop1,
        afterHop2,
        `two hops wrote different sections: ${afterHop1.join("|")} then ${afterHop2.join("|")}`,
      );
    } else {
      const hop1Body = await hop1.then(async (response) => ({
        status: response.status,
        body: await response.json(),
      }));
      assert.notEqual(hop1State, "timeout", "the read hop did not finish");
      assert.equal(
        filingCalls.filter((call) => call.startedAt > hop1Deadline).length,
        0,
        `hop 1 filed after the deadline: ${JSON.stringify(hop1Body)}`,
      );
      filingSection = "hr";
      holdMode = "none";
      shiftOnRead = false;
      captureDeadline = true;
      const hop2Response = await GET(
        new Request(`http://127.0.0.1/api/v2/read?accountId=${accountId}`),
      );
      const hop2Deadline = capturedDeadline;
      assert.equal(hop2Response.status, 200);
      const late = filingCalls.filter((call) => call.startedAt > hop2Deadline);
      assert.equal(late.length, 0, "the hop that holds the lease stops at its own deadline");
      const sections = await matterSections(database, accountId);
      assert.ok(
        sections.every((section) => section === "hr"),
        `the remainder is filed by the hop that holds the lease, saw ${sections.join("|")}`,
      );
    }
  } catch (error) {
    failures.push(error instanceof Error ? error.message : String(error));
  }

  assert.equal(failures.length, 0, failures.join("\n\n"));
  console.log("v2-read-filing-deadline: OK");
} finally {
  Date.now = realNow;
  releaseFiling();
  process.env.NODE_ENV = previousNodeEnv;
  delete globalThis.AI_SDK_DEFAULT_PROVIDER;
  await database.stop();
}
