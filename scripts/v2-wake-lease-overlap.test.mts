/**
 * Spec for the push-wake / cron lease overlap.
 *
 * These tests fail while a push wake or a login catch-up still does provider
 * or model work on a mailbox whose sync or read lease another worker holds.
 * They pass once that work is skipped, a wake claims both leases before
 * doing the work, and a finishing wake cannot delete a newer worker's lease.
 *
 * Run: npx tsx scripts/v2-wake-lease-overlap.test.mts
 */
import assert from "node:assert/strict";
import "next/dist/server/node-environment-baseline.js";
import { AfterContext } from "next/dist/server/after/after-context.js";
import { workAsyncStorage } from "next/dist/server/app-render/work-async-storage.external.js";
import { startTestDb, type TestDb } from "./v2-testdb.mts";
import { upsertAccountWithCredentials, upsertUser } from "../src/lib/v2/db/accounts.ts";
import { setPoolForTesting } from "../src/lib/v2/db/pool.ts";
import { claimWorkerLease } from "../src/lib/v2/cron/lease.ts";
import { upsertPushSubscription } from "../src/lib/v2/push/repository.ts";
import {
  graphClientState,
  graphClientStateHash,
} from "../src/lib/v2/push/security.ts";
import { catchUpInbox, inboxNeedsCatchUp } from "../src/lib/v2/sync/catch-up.ts";
import { wakeAccount } from "../src/lib/v2/sync/wake-account.ts";
import type { MailAccount } from "../src/lib/v2/db/accounts.ts";
import type { Pool, PoolClient, QueryResult } from "pg";

if (!process.env.CRON_SECRET) {
  process.env.CRON_SECRET = "placeholder-cron-secret";
}
process.env.AI_GATEWAY_API_KEY = "placeholder-ai-gateway-key";
process.env.SEER_WEBHOOK_PEPPER = "placeholder-webhook-pepper";

const READ_DECISION = {
  home: "record",
  summary: "A contract was sent for review.",
  rationale: "Keep the contract.",
  owner: "nobody",
  ask: null,
  obligation: false,
  dueDate: null,
  matterRef: null,
  yields: [],
  evidence: [],
};

const GMAIL_THREAD_ID = "thread-1";
const GRAPH_CONVERSATION_ID = "graph-conv-1";

type Kind = "sync" | "read";
type LeaseSnapshot = { kind: string; expiresAt: string };

type Effects = {
  provider: number;
  model: number;
  nestedProvider: number;
  nestedModel: number;
};

const effects: Effects = {
  provider: 0,
  model: 0,
  nestedProvider: 0,
  nestedModel: 0,
};

let nest = 0;
let armSyncOverlap = false;
let overlapAccountId = "";
let overlapEmail = "";
let overlapRan = false;
let oracle: LeaseOracle | null = null;
let database: TestDb;
const seenUrls: string[] = [];

function resetEffects(): void {
  effects.provider = 0;
  effects.model = 0;
  effects.nestedProvider = 0;
  effects.nestedModel = 0;
  nest = 0;
  armSyncOverlap = false;
  overlapAccountId = "";
  overlapEmail = "";
  overlapRan = false;
  seenUrls.length = 0;
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function modelResult(text: string): unknown {
  return {
    content: [{ type: "text", text }],
    finishReason: { unified: "stop", raw: "stop" },
    usage: {
      inputTokens: { total: 12, noCache: 12, cacheRead: 0, cacheWrite: 0 },
      outputTokens: { total: 8, text: 8, reasoning: 0 },
    },
    warnings: [],
  };
}

function gmailThread(): unknown {
  const text = Buffer.from("Please review the contract.").toString("base64url");
  return {
    id: GMAIL_THREAD_ID,
    messages: [
      {
        id: "msg-1",
        threadId: GMAIL_THREAD_ID,
        snippet: "Please review the contract.",
        labelIds: ["INBOX", "UNREAD"],
        internalDate: String(Date.parse("2026-09-01T12:00:00Z")),
        payload: {
          mimeType: "text/plain",
          headers: [
            { name: "From", value: "Alex Sender <alex.sender@example.com>" },
            { name: "To", value: "connected-mailbox@example.com" },
            { name: "Subject", value: "Contract review" },
          ],
          body: { data: text, size: text.length },
        },
      },
    ],
  };
}

function graphMessage(withBody: boolean): unknown {
  return {
    id: "graph-msg-1",
    conversationId: GRAPH_CONVERSATION_ID,
    subject: "Contract review",
    from: {
      emailAddress: { address: "alex.sender@example.com", name: "Alex Sender" },
    },
    toRecipients: [
      { emailAddress: { address: "outlook-mailbox@example.com", name: "Owner" } },
    ],
    ccRecipients: [],
    receivedDateTime: "2026-09-01T12:00:00Z",
    bodyPreview: "Please review the contract.",
    isRead: false,
    hasAttachments: false,
    parentFolderId: "inbox",
    ...(withBody
      ? {
          body: { contentType: "text", content: "Please review the contract." },
          attachments: [],
        }
      : {}),
  };
}

function providerBody(url: URL): unknown {
  const host = url.hostname;
  if (host === "gmail.googleapis.com") {
    if (url.pathname.endsWith(`/threads/${GMAIL_THREAD_ID}`)) return gmailThread();
    if (url.pathname.endsWith("/threads")) {
      return { threads: [{ id: GMAIL_THREAD_ID }], resultSizeEstimate: 1 };
    }
  }
  if (host === "graph.microsoft.com") {
    if (url.pathname.endsWith("/messages") && url.searchParams.has("$filter")) {
      return { value: [graphMessage(true)] };
    }
    if (url.pathname.includes("/mailFolders/") && url.pathname.endsWith("/messages")) {
      return { value: [graphMessage(false)], "@odata.count": 1 };
    }
    if (url.searchParams.has("$select") && url.searchParams.get("$select") === "totalItemCount") {
      return { totalItemCount: 1 };
    }
  }
  throw new Error(`stand-in has no provider response for ${url.origin}${url.pathname}`);
}

function modelBody(raw: string): unknown {
  if (raw.includes("You are a chief of staff")) {
    return modelResult(JSON.stringify(READ_DECISION));
  }
  if (raw.includes("You file an executive")) {
    return modelResult(JSON.stringify({ filings: [] }));
  }
  if (raw.includes("Name the active work board")) {
    return modelResult(JSON.stringify({ matters: [] }));
  }
  throw new Error("stand-in has no model response for this gateway prompt");
}

async function requestText(init: RequestInit | undefined): Promise<string> {
  const body = init?.body;
  if (typeof body === "string") return body;
  if (body instanceof Uint8Array) return Buffer.from(body).toString("utf8");
  if (body instanceof ArrayBuffer) return Buffer.from(body).toString("utf8");
  return "";
}

async function installFetch(): Promise<void> {
  const { POST: gmailPost } = await import("../src/app/api/webhooks/gmail/route.ts");
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(
      typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
    );
    const provider = url.hostname === "gmail.googleapis.com" || url.hostname === "graph.microsoft.com";
    const model = url.hostname === "ai-gateway.vercel.sh";
    seenUrls.push(`${nest}:${url.origin}${url.pathname}`);
    if (!provider && !model) {
      return original(input, init);
    }
    if (provider && armSyncOverlap && nest === 0 && url.pathname.endsWith("/threads")) {
      const held = await database.pool.query(
        `select 1 from seer.worker_leases
          where account_id = $1 and kind = 'sync' and expires_at > now()`,
        [overlapAccountId],
      );
      assert.equal(
        held.rowCount,
        1,
        "the sync worker still holds the lease when the push is handled",
      );
      nest += 1;
      overlapRan = true;
      try {
        await runInRequest(() =>
          gmailPost(
            new Request("https://example.com/api/webhooks/gmail", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: pubsubBody(overlapEmail),
            }),
          ),
        );
      } finally {
        nest -= 1;
      }
    }
    const nested = nest > 0;
    if (provider) {
      effects.provider += 1;
      if (nested) effects.nestedProvider += 1;
    }
    if (model) {
      effects.model += 1;
      if (nested) effects.nestedModel += 1;
    }
    oracle?.onWork();
    if (provider) return jsonResponse(providerBody(url));
    return jsonResponse(modelBody(await requestText(init)));
  }) as typeof fetch;
}

function pubsubBody(email: string): string {
  const data = Buffer.from(
    JSON.stringify({ emailAddress: email, historyId: "1001" }),
    "utf8",
  ).toString("base64");
  return JSON.stringify({ message: { data, messageId: "push-1" } });
}

async function runInRequest<T>(fn: () => Promise<T>): Promise<T> {
  let close = () => {};
  const pending: Promise<unknown>[] = [];
  const afterContext = new AfterContext({
    waitUntil(task) {
      pending.push(Promise.resolve(task));
    },
    onClose(callback) {
      close = callback;
    },
    onTaskError(error) {
      throw error;
    },
  });
  const store = {
    afterContext,
    pendingRevalidatedTags: [] as string[],
    pendingRevalidates: {} as Record<string, Promise<unknown>>,
    pendingRevalidateWrites: [] as Promise<void>[],
  };
  const result = await workAsyncStorage.run(store as never, fn);
  close();
  await Promise.all(pending);
  return result;
}

async function connectMailbox(
  email: string,
  provider: "google" | "microsoft",
): Promise<MailAccount> {
  await database.pool.query(`delete from seer.mail_accounts where email = $1`, [
    email.toLowerCase(),
  ]);
  const userId = await upsertUser(email);
  return upsertAccountWithCredentials({
    userId,
    provider,
    email,
    accessToken: "placeholder-access-token",
    expiresAt: Date.now() + 7 * 24 * 60 * 60 * 1000,
  });
}

async function disconnect(accountId: string): Promise<void> {
  await database.pool.query(`delete from seer.mail_accounts where id = $1`, [accountId]);
}

async function counts(accountId: string): Promise<{ decisions: number; usage: number }> {
  const decisions = await database.pool.query<{ n: number }>(
    `select count(*)::int as n from seer.conversation_decisions where account_id = $1`,
    [accountId],
  );
  const usage = await database.pool.query<{ n: number }>(
    `select count(*)::int as n from seer.model_usage where account_id = $1`,
    [accountId],
  );
  return { decisions: decisions.rows[0].n, usage: usage.rows[0].n };
}

async function leaseExpiry(accountId: string, kind: Kind): Promise<string | null> {
  const result = await database.pool.query<{ expires_at: Date }>(
    `select expires_at from seer.worker_leases
      where account_id = $1 and kind = $2`,
    [accountId, kind],
  );
  const value = result.rows[0]?.expires_at;
  return value ? new Date(value).toISOString() : null;
}

function sqlText(query: unknown): string {
  if (typeof query === "string") return query;
  if (query && typeof query === "object" && "text" in query) {
    const text = (query as { text?: unknown }).text;
    if (typeof text === "string") return text;
  }
  return "";
}

function sqlParams(query: unknown, values: unknown): unknown[] {
  if (Array.isArray(values)) return values;
  if (query && typeof query === "object" && "values" in query) {
    const nested = (query as { values?: unknown }).values;
    if (Array.isArray(nested)) return nested;
  }
  return [];
}

class LeaseOracle {
  claimed = new Set<Kind>();
  workStarted = false;
  violations: string[] = [];
  stolen: LeaseSnapshot[] | null = null;
  private stealing = false;

  constructor(
    private readonly accountId: string,
    private readonly mode: "stale-read" | "fence",
  ) {}

  onWork(): void {
    if (this.workStarted) return;
    this.workStarted = true;
    if (!this.claimed.has("sync") || !this.claimed.has("read")) {
      this.violations.push(
        "provider or model work started without this wake claiming both the sync and read leases",
      );
    }
  }

  async gate(
    query: unknown,
    values: unknown,
    run: () => Promise<QueryResult>,
    raw: (text: string, params?: unknown[]) => Promise<QueryResult>,
  ): Promise<QueryResult> {
    const text = sqlText(query);
    const params = sqlParams(query, values);
    const mentions = /seer\.worker_leases/i.test(text);
    const isClaim = mentions && /insert\s+into/i.test(text) && /on conflict/i.test(text);
    const isDelete = mentions && /delete\s+from/i.test(text);
    const isSelect = mentions && /^\s*select\b/i.test(text) && !isClaim && !isDelete;

    if (isClaim && !this.stealing) {
      const result = await run();
      if ((result.rowCount ?? 0) > 0 && !this.workStarted) {
        const kind = params[1];
        if (kind === "sync" || kind === "read") this.claimed.add(kind);
      }
      return result;
    }

    if (isSelect && this.mode === "stale-read" && !this.workStarted) {
      const result = await run();
      await this.plantMissing(database.pool);
      return result;
    }

    if (this.mode === "fence" && this.workStarted && isSelect && !this.stolen) {
      const result = await run();
      await this.steal(raw);
      return result;
    }

    if (this.mode === "fence" && this.workStarted && isDelete) {
      if (!this.stolen) await this.steal(raw);
      return run();
    }

    return run();
  }

  private async plantMissing(pool: Pool): Promise<void> {
    for (const kind of ["sync", "read"] as const) {
      if (this.claimed.has(kind)) continue;
      await pool.query(
        `insert into seer.worker_leases (account_id, kind, expires_at)
         values ($1, $2, now() + interval '5 minutes')
         on conflict (account_id, kind) do nothing`,
        [this.accountId, kind],
      );
    }
  }

  private async steal(
    raw: (text: string, params?: unknown[]) => Promise<QueryResult>,
  ): Promise<void> {
    if (this.stolen || this.stealing) return;
    this.stealing = true;
    try {
      await raw(
        `update seer.worker_leases
            set expires_at = now() - interval '1 second'
          where account_id = $1`,
        [this.accountId],
      );
      const claim = `insert into seer.worker_leases (account_id, kind, expires_at)
         values ($1, $2, now() + make_interval(secs => $3))
         on conflict (account_id, kind) do update
           set expires_at = excluded.expires_at
         where seer.worker_leases.expires_at < now()
         returning account_id`;
      for (const kind of ["sync", "read"] as const) {
        await raw(claim, [this.accountId, kind, 300]);
      }
      const rows = await raw(
        `select kind, expires_at
           from seer.worker_leases
          where account_id = $1
          order by kind`,
        [this.accountId],
      );
      this.stolen = rows.rows.map((row) => ({
        kind: String(row.kind),
        expiresAt: new Date(row.expires_at as string | Date).toISOString(),
      }));
    } finally {
      this.stealing = false;
    }
  }
}

function wrapPool(pool: Pool, next: LeaseOracle): Pool {
  const wrap = (client: Pool | PoolClient): Pool =>
    new Proxy(client, {
      get(target, prop, receiver) {
        if (prop === "query") {
          return (query: unknown, values?: unknown) =>
            next.gate(
              query,
              values,
              () => (target.query as Pool["query"])(query as never, values as never),
              (text, params) => (target.query as Pool["query"])(text, params),
            );
        }
        if (prop === "connect" && "connect" in target) {
          return async () => {
            const child = await (target as Pool).connect();
            return wrap(child);
          };
        }
        const value = Reflect.get(target, prop, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as Pool;
  return wrap(pool);
}

async function withOracle<T>(
  accountId: string,
  mode: "stale-read" | "fence",
  run: (gate: LeaseOracle) => Promise<T>,
): Promise<T> {
  const gate = new LeaseOracle(accountId, mode);
  oracle = gate;
  setPoolForTesting(wrapPool(database.pool, gate));
  try {
    return await run(gate);
  } finally {
    oracle = null;
    setPoolForTesting(database.pool);
  }
}

async function main(): Promise<void> {
  database = await startTestDb();
  try {
    await installFetch();

    const cases = [
      testIdleWakeWritesDecision,
      testGmailPushOverlapsLiveSync,
      testGmailPushOverlapsLiveRead,
      testOutlookPushOverlapsLiveSync,
      testCatchUpOverlapsLiveSync,
      testStaleLeaseReadCannotAuthorizeWork,
      testFinishingWakeCannotDeleteNewerLease,
    ];
    const failures: string[] = [];
    for (const run of cases) {
      try {
        await run();
      } catch (error) {
        failures.push(`${run.name}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    if (failures.length > 0) {
      throw new Error(failures.join("\n"));
    }
    console.log("v2-wake-lease-overlap: OK");
  } finally {
    await database.stop();
  }
}

async function testIdleWakeWritesDecision(): Promise<void> {
  resetEffects();
  const account = await connectMailbox("idle-mailbox@example.com", "google");
  try {
    await upsertPushSubscription(account.id, "google", {});
    const report = await wakeAccount(account.id);
    assert.equal(report.error, undefined, report.error);
    assert.ok(effects.provider > 0, "an idle wake reaches the mailbox provider");
    assert.ok(effects.model > 0, "an idle wake calls the model");
    const written = await counts(account.id);
    assert.ok(written.decisions > 0, "an idle wake persists a triage decision");
    assert.ok(written.usage > 0, "an idle wake records model usage");
    console.log("idle wake writes a decision: OK");
  } finally {
    await disconnect(account.id);
  }
}

async function testGmailPushOverlapsLiveSync(): Promise<void> {
  resetEffects();
  const account = await connectMailbox("sync-overlap@example.com", "google");
  try {
    await upsertPushSubscription(account.id, "google", {});
    overlapAccountId = account.id;
    overlapEmail = account.email;
    armSyncOverlap = true;
    const { GET } = await import("../src/app/api/v2/sync/route.ts");
    const response = await GET(
      new Request(
        `https://example.com/api/v2/sync?accountId=${account.id}`,
        { headers: { authorization: `Bearer ${process.env.CRON_SECRET}` } },
      ),
    );
    assert.equal(response.status, 200);
    const body = (await response.json()) as { report?: { skipped?: string; error?: string }[] };
    assert.notEqual(body.report?.[0]?.skipped, "lease");
    assert.equal(overlapRan, true, `push was not delivered during sync; urls=${seenUrls.join(" ")}`);
    assert.ok(effects.provider > effects.nestedProvider, "the cron sync must reach the provider");
    const written = await counts(account.id);
    assert.deepEqual(
      {
        provider: effects.nestedProvider,
        model: effects.nestedModel,
        decisions: written.decisions,
        usage: written.usage,
      },
      { provider: 0, model: 0, decisions: 0, usage: 0 },
      "gmail push must not fetch, call the model, or write a decision while the sync worker holds the mailbox",
    );
    console.log("gmail push overlaps a live sync: checked");
  } finally {
    await disconnect(account.id);
  }
}

async function testGmailPushOverlapsLiveRead(): Promise<void> {
  resetEffects();
  const account = await connectMailbox("read-overlap@example.com", "google");
  try {
    await upsertPushSubscription(account.id, "google", {});
    assert.equal(await claimWorkerLease(account.id, "read"), true);
    const before = await leaseExpiry(account.id, "read");
    const { POST } = await import("../src/app/api/webhooks/gmail/route.ts");
    const response = await runInRequest(() =>
      POST(
        new Request("https://example.com/api/webhooks/gmail", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: pubsubBody(account.email),
        }),
      ),
    );
    assert.equal(response.status, 200);
    const payload = (await response.json()) as { waking?: string; deduped?: boolean };
    assert.equal(payload.deduped, undefined);
    assert.equal(payload.waking, account.email);
    const written = await counts(account.id);
    assert.deepEqual(
      {
        provider: effects.provider,
        model: effects.model,
        decisions: written.decisions,
        usage: written.usage,
      },
      { provider: 0, model: 0, decisions: 0, usage: 0 },
      "gmail push must not fetch, call the model, or write a decision while the read lease is held",
    );
    assert.equal(
      await leaseExpiry(account.id, "read"),
      before,
      "a wake that did not acquire the read lease must leave the holder's expiry in place",
    );
    console.log("gmail push overlaps a live read: checked");
  } finally {
    await disconnect(account.id);
  }
}

async function testOutlookPushOverlapsLiveSync(): Promise<void> {
  resetEffects();
  const account = await connectMailbox("outlook-overlap@example.com", "microsoft");
  try {
    await upsertPushSubscription(account.id, "microsoft", {
      graphSubscriptionId: "graph-subscription-1",
      graphClientStateHash: graphClientStateHash(account.id),
    });
    assert.equal(await claimWorkerLease(account.id, "sync"), true);
    const before = await leaseExpiry(account.id, "sync");
    const { POST } = await import("../src/app/api/webhooks/outlook/route.ts");
    const response = await runInRequest(() =>
      POST(
        new Request("https://example.com/api/webhooks/outlook", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            value: [
              {
                subscriptionId: "graph-subscription-1",
                clientState: graphClientState(account.id),
                changeType: "created",
              },
            ],
          }),
        }),
      ),
    );
    assert.equal(response.status, 200);
    const payload = (await response.json()) as { waking?: number };
    assert.equal(payload.waking, 1);
    const written = await counts(account.id);
    assert.deepEqual(
      {
        provider: effects.provider,
        model: effects.model,
        decisions: written.decisions,
        usage: written.usage,
      },
      { provider: 0, model: 0, decisions: 0, usage: 0 },
      "outlook push must not fetch, call the model, or write a decision while the sync lease is held",
    );
    assert.equal(await leaseExpiry(account.id, "sync"), before);
    console.log("outlook push overlaps a live sync: checked");
  } finally {
    await disconnect(account.id);
  }
}

async function testCatchUpOverlapsLiveSync(): Promise<void> {
  resetEffects();
  const account = await connectMailbox("catchup-overlap@example.com", "google");
  try {
    assert.equal(await inboxNeedsCatchUp(account.id), true);
    assert.equal(await claimWorkerLease(account.id, "sync"), true);
    const before = await leaseExpiry(account.id, "sync");
    await catchUpInbox(account);
    assert.deepEqual(
      { provider: effects.provider, model: effects.model },
      { provider: 0, model: 0 },
      "login catch-up must not fetch the mailbox while the sync lease is held",
    );
    assert.equal(await leaseExpiry(account.id, "sync"), before);
    console.log("login catch-up overlaps a live sync: checked");
  } finally {
    await disconnect(account.id);
  }
}

async function testStaleLeaseReadCannotAuthorizeWork(): Promise<void> {
  resetEffects();
  const account = await connectMailbox("stale-read@example.com", "google");
  try {
    await upsertPushSubscription(account.id, "google", {});
    const gate = await withOracle(account.id, "stale-read", async (oracleGate) => {
      await wakeAccount(account.id);
      return oracleGate;
    });
    assert.deepEqual(
      gate.violations,
      [],
      "a lease lookup that is stale before the provider call must not be reused",
    );
    console.log("stale lease lookup cannot authorize work: checked");
  } finally {
    await disconnect(account.id);
  }
}

async function testFinishingWakeCannotDeleteNewerLease(): Promise<void> {
  resetEffects();
  const account = await connectMailbox("fence@example.com", "google");
  try {
  await upsertPushSubscription(account.id, "google", {});
  const gate = await withOracle(account.id, "fence", async (oracleGate) => {
    const report = await wakeAccount(account.id);
    assert.equal(report.error, undefined, report.error);
    return oracleGate;
  });
  assert.deepEqual(
    gate.violations,
    [],
    "provider and model work require this wake to have claimed both leases",
  );
  assert.ok(gate.stolen, "a finishing wake must release through a compare-and-delete");
  const left = await database.pool.query<{ kind: string; expires_at: Date }>(
    `select kind, expires_at
       from seer.worker_leases
      where account_id = $1
      order by kind`,
    [account.id],
  );
  assert.deepEqual(
    left.rows.map((row) => ({
      kind: row.kind,
      expiresAt: new Date(row.expires_at).toISOString(),
    })),
    gate.stolen,
    "a finishing wake must not delete a lease a newer worker acquired",
  );
    console.log("finishing wake cannot delete a newer lease: checked");
  } finally {
    await disconnect(account.id);
  }
}

await main();
