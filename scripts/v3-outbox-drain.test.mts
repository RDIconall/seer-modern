/**
 * Task 4 gate: outbox drain claims safely, reclaims stale inflight, preserves
 * idempotency keys, classifies retries, and handles partial provider failure.
 */
import assert from "node:assert/strict";
import { startTestDb } from "./v2-testdb.mts";
import { upsertUser, upsertAccount } from "../src/lib/v2/db/accounts.ts";
import { enqueueOptimistic } from "../src/lib/v3/outbox/repository.ts";
import {
  drainOutbox,
  MAX_OUTBOX_ATTEMPTS,
  INFLIGHT_LEASE_MS,
} from "../src/lib/v3/outbox/drain.ts";
import { ProviderHttpError } from "../src/lib/v2/providers/http.ts";
import { FakeProvider } from "../src/lib/v2/providers/fake.ts";
import { asAccountId, type AccountId } from "../src/lib/v2/db/types.ts";
import type { MailProvider } from "../src/lib/v2/providers/types.ts";

async function seedConversation(
  pool: import("pg").Pool,
  accountId: AccountId,
  providerId: string,
  folders: string[],
  isUnread: boolean,
): Promise<string> {
  const r = await pool.query<{ id: string }>(
    `insert into seer.conversations
       (account_id, provider_conversation_id, subject, last_message_at, folders, is_unread)
     values ($1, $2, 'subject', now(), $3::text[], $4)
     returning id`,
    [accountId, providerId, folders, isUnread],
  );
  return r.rows[0].id;
}

class ThrowingProvider extends FakeProvider {
  calls = 0;
  constructor(
    private readonly error: Error,
    conversations: ConstructorParameters<typeof FakeProvider>[0] = {},
  ) {
    super(conversations);
  }

  override async mutateConversation(
    _id: string,
    _action: Parameters<MailProvider["mutateConversation"]>[1],
    _key: string,
  ) {
    this.calls += 1;
    throw this.error;
  }
}

const db = await startTestDb();
try {
  const userId = await upsertUser("outbox-drain@example.com");
  const accountId = asAccountId(
    await upsertAccount({
      userId,
      provider: "google",
      email: "outbox-drain@example.com",
    }),
  );

  const provider = new FakeProvider({
    conversations: [
      {
        providerConversationId: "p-old",
        subject: "Old",
        messages: [
          {
            providerMessageId: "m-old",
            from: { email: "a@example.com" },
            to: [{ email: "me@example.com" }],
            cc: [],
            sentAt: "2026-08-01T10:00:00Z",
            snippet: "s",
            bodyHtml: null,
            bodyText: "t",
            isUnread: false,
            isOutgoing: false,
            attachments: [],
            folder: "inbox",
          },
        ],
      },
      {
        providerConversationId: "p-new",
        subject: "New",
        messages: [
          {
            providerMessageId: "m-new",
            from: { email: "b@example.com" },
            to: [{ email: "me@example.com" }],
            cc: [],
            sentAt: "2026-08-02T10:00:00Z",
            snippet: "s",
            bodyHtml: null,
            bodyText: "t",
            isUnread: false,
            isOutgoing: false,
            attachments: [],
            folder: "inbox",
          },
        ],
      },
      {
        providerConversationId: "p-reclaim",
        subject: "Reclaim",
        messages: [
          {
            providerMessageId: "m-reclaim",
            from: { email: "a@example.com" },
            to: [{ email: "me@example.com" }],
            cc: [],
            sentAt: "2026-08-01T10:00:00Z",
            snippet: "s",
            bodyHtml: null,
            bodyText: "t",
            isUnread: false,
            isOutgoing: false,
            attachments: [],
            folder: "inbox",
          },
        ],
      },
    ],
  });

  const oldId = await seedConversation(db.pool, accountId, "p-old", ["inbox"], false);
  const newId = await seedConversation(db.pool, accountId, "p-new", ["inbox"], false);

  const first = await enqueueOptimistic(
    accountId,
    { type: "archive", conversationId: oldId },
    "drain-old",
  );
  await new Promise((r) => setTimeout(r, 5));
  await enqueueOptimistic(accountId, { type: "archive", conversationId: newId }, "drain-new");

  const report = await drainOutbox(accountId, provider, { limit: 1 });
  assert.equal(report.done, 1);

  const report2 = await drainOutbox(accountId, provider, { limit: 1 });
  assert.equal(report2.done, 1);

  // -------------------------------------------------------------------------
  // Stale inflight reclaim
  // -------------------------------------------------------------------------
  const reclaimId = await seedConversation(db.pool, accountId, "p-reclaim", ["inbox"], false);
  const reclaimItem = await enqueueOptimistic(
    accountId,
    { type: "archive", conversationId: reclaimId },
    "reclaim-key",
  );
  await db.pool.query(
    `update seer.outbox
        set status = 'inflight',
            updated_at = now() - ($2::int * interval '1 millisecond')
      where id = $1`,
    [reclaimItem.id, INFLIGHT_LEASE_MS + 1000],
  );
  const reclaimReport = await drainOutbox(accountId, provider, {
    limit: 1,
    leaseMs: INFLIGHT_LEASE_MS,
  });
  assert.equal(reclaimReport.reclaimed, 1);
  assert.equal(reclaimReport.done, 1);

  // -------------------------------------------------------------------------
  // Partial provider failure preserves optimistic state
  // -------------------------------------------------------------------------
  const partialProvider = new FakeProvider({
    conversations: [
      {
        providerConversationId: "p-partial",
        subject: "Partial",
        messages: [
          {
            providerMessageId: "m-ok",
            from: { email: "a@example.com" },
            to: [{ email: "me@example.com" }],
            cc: [],
            sentAt: "2026-08-01T10:00:00Z",
            snippet: "s",
            bodyHtml: null,
            bodyText: "t",
            isUnread: false,
            isOutgoing: false,
            attachments: [],
            folder: "inbox",
          },
          {
            providerMessageId: "m-bad",
            from: { email: "a@example.com" },
            to: [{ email: "me@example.com" }],
            cc: [],
            sentAt: "2026-08-01T10:01:00Z",
            snippet: "s",
            bodyHtml: null,
            bodyText: "t",
            isUnread: false,
            isOutgoing: false,
            attachments: [],
            folder: "inbox",
            failMutation: true,
          },
        ],
      },
    ],
  });

  const partialId = await seedConversation(db.pool, accountId, "p-partial", ["inbox"], false);
  await enqueueOptimistic(
    accountId,
    { type: "trash", conversationId: partialId },
    "partial-key",
  );
  const partialDrain = await drainOutbox(accountId, partialProvider, { limit: 1 });
  assert.equal(partialDrain.failed, 1);

  const partialRow = await db.pool.query<{ status: string }>(
    "select status from seer.outbox where idempotency_key = $1",
    ["partial-key"],
  );
  assert.equal(partialRow.rows[0].status, "failed");

  const partialFolders = await db.pool.query<{ folders: string[] }>(
    "select folders from seer.conversations where id = $1",
    [partialId],
  );
  assert.deepEqual(
    partialFolders.rows[0].folders.sort(),
    ["trash"],
    "partial success must not revert optimistic trash state",
  );

  const partialEvents = await db.pool.query<{ kind: string }>(
    "select kind from seer.events where account_id = $1 and idempotency_key = $2",
    [accountId, "partial-key"],
  );
  assert.ok(
    partialEvents.rows.some((e) => e.kind === "outbox_reconcile_needed"),
    "partial failure must queue reconciliation",
  );

  // -------------------------------------------------------------------------
  // Permanent auth failure — no retry budget consumed
  // -------------------------------------------------------------------------
  const authId = await seedConversation(db.pool, accountId, "p-auth", ["inbox"], false);
  await enqueueOptimistic(
    accountId,
    { type: "archive", conversationId: authId },
    "auth-key",
  );
  const authProvider = new ThrowingProvider(
    new ProviderHttpError(403, "gmail", "forbidden"),
    {
      conversations: [
        {
          providerConversationId: "p-auth",
          subject: "Auth",
          messages: [
            {
              providerMessageId: "m-auth",
              from: { email: "a@example.com" },
              to: [{ email: "me@example.com" }],
              cc: [],
              sentAt: "2026-08-01T10:00:00Z",
              snippet: "s",
              bodyHtml: null,
              bodyText: "t",
              isUnread: false,
              isOutgoing: false,
              attachments: [],
              folder: "inbox",
            },
          ],
        },
      ],
    },
  );
  const authDrain = await drainOutbox(accountId, authProvider, { limit: 1 });
  assert.equal(authDrain.failed, 1);
  const authRow = await db.pool.query<{ attempts: number }>(
    "select attempts from seer.outbox where idempotency_key = $1",
    ["auth-key"],
  );
  assert.equal(authRow.rows[0].attempts, 1, "permanent failure must not exhaust retry budget");

  // -------------------------------------------------------------------------
  // Transient failure: backoff then success
  // -------------------------------------------------------------------------
  const transientId = await seedConversation(db.pool, accountId, "p-transient", ["inbox"], false);
  await enqueueOptimistic(
    accountId,
    { type: "archive", conversationId: transientId },
    "transient-key",
  );

  const flaky = new ThrowingProvider(new Error("network timeout"), {
    conversations: [
      {
        providerConversationId: "p-transient",
        subject: "Transient",
        messages: [
          {
            providerMessageId: "m-transient",
            from: { email: "a@example.com" },
            to: [{ email: "me@example.com" }],
            cc: [],
            sentAt: "2026-08-01T10:00:00Z",
            snippet: "s",
            bodyHtml: null,
            bodyText: "t",
            isUnread: false,
            isOutgoing: false,
            attachments: [],
            folder: "inbox",
          },
        ],
      },
    ],
  });
  const transientSuccess = new FakeProvider({
    conversations: [
      {
        providerConversationId: "p-transient",
        subject: "Transient",
        messages: [
          {
            providerMessageId: "m-transient",
            from: { email: "a@example.com" },
            to: [{ email: "me@example.com" }],
            cc: [],
            sentAt: "2026-08-01T10:00:00Z",
            snippet: "s",
            bodyHtml: null,
            bodyText: "t",
            isUnread: false,
            isOutgoing: false,
            attachments: [],
            folder: "inbox",
          },
        ],
      },
    ],
  });

  const retry1 = await drainOutbox(accountId, flaky, { limit: 1 });
  assert.equal(retry1.retried, 1);
  assert.equal(flaky.calls, 1);

  await db.pool.query(
    "update seer.outbox set next_attempt_at = now() - interval '1 second' where idempotency_key = $1",
    ["transient-key"],
  );
  const success = await drainOutbox(accountId, transientSuccess, { limit: 1 });
  assert.equal(success.done, 1);

  // Full failure with zero processed still reverts after max attempts.
  const zeroId = await seedConversation(db.pool, accountId, "p-zero", ["inbox"], false);
  await enqueueOptimistic(
    accountId,
    { type: "trash", conversationId: zeroId },
    "zero-key",
  );
  const zeroProvider = new FakeProvider({
    conversations: [
      {
        providerConversationId: "p-zero",
        subject: "Zero",
        messages: [
          {
            providerMessageId: "m-zero",
            from: { email: "a@example.com" },
            to: [{ email: "me@example.com" }],
            cc: [],
            sentAt: "2026-08-01T10:00:00Z",
            snippet: "s",
            bodyHtml: null,
            bodyText: "t",
            isUnread: false,
            isOutgoing: false,
            attachments: [],
            folder: "inbox",
            failMutation: true,
          },
        ],
      },
    ],
  });
  for (let i = 0; i < MAX_OUTBOX_ATTEMPTS; i++) {
    await db.pool.query(
      "update seer.outbox set next_attempt_at = now() - interval '1 second' where idempotency_key = $1",
      ["zero-key"],
    );
    await drainOutbox(accountId, zeroProvider, { limit: 1 });
  }
  const zeroFolders = await db.pool.query<{ folders: string[] }>(
    "select folders from seer.conversations where id = $1",
    [zeroId],
  );
  assert.deepEqual(
    zeroFolders.rows[0].folders.sort(),
    ["inbox"],
    "total provider failure reverts when nothing processed",
  );

  console.log("v3-outbox-drain: OK");
} finally {
  await db.stop();
}
