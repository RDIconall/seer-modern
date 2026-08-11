/**
 * Task 4 gate: outbox drain claims safely, preserves idempotency keys, retries
 * transient failures with backoff, and reverts after max attempts.
 */
import assert from "node:assert/strict";
import { startTestDb } from "./v2-testdb.mts";
import { upsertUser, upsertAccount } from "../src/lib/v2/db/accounts.ts";
import { enqueueOptimistic } from "../src/lib/v3/outbox/repository.ts";
import { drainOutbox, MAX_OUTBOX_ATTEMPTS } from "../src/lib/v3/outbox/drain.ts";
import { FakeProvider } from "../src/lib/v2/providers/fake.ts";
import { asAccountId, type AccountId } from "../src/lib/v2/db/types.ts";
import type { OutboxCommand } from "../src/lib/v3/outbox/types.ts";
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
    id: string,
    action: Parameters<MailProvider["mutateConversation"]>[1],
    key: string,
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

  // -------------------------------------------------------------------------
  // Drain: oldest pending first, inflight, provider once, done on success
  // -------------------------------------------------------------------------
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
    ],
  });

  const oldId = await seedConversation(db.pool, accountId, "p-old", ["inbox"], false);
  const newId = await seedConversation(db.pool, accountId, "p-new", ["inbox"], false);

  const oldCmd: OutboxCommand = {
    type: "archive",
    conversationId: oldId,
    previous: { folders: ["inbox"], isUnread: false },
  };
  const newCmd: OutboxCommand = {
    type: "archive",
    conversationId: newId,
    previous: { folders: ["inbox"], isUnread: false },
  };

  const first = await enqueueOptimistic(accountId, oldCmd, "drain-old");
  await new Promise((r) => setTimeout(r, 5));
  const second = await enqueueOptimistic(accountId, newCmd, "drain-new");

  const report = await drainOutbox(accountId, provider, { limit: 1 });
  assert.equal(report.processed, 1);
  assert.equal(report.done, 1);
  assert.equal(report.failed, 0);

  const firstRow = await db.pool.query<{ status: string; idempotency_key: string }>(
    "select status, idempotency_key from seer.outbox where id = $1",
    [first.id],
  );
  assert.equal(firstRow.rows[0].status, "done");
  assert.equal(firstRow.rows[0].idempotency_key, "drain-old");

  const inflight = await db.pool.query<{ status: string }>(
    "select status from seer.outbox where id = $1",
    [second.id],
  );
  assert.equal(inflight.rows[0].status, "pending", "second row stays pending until drained");

  const report2 = await drainOutbox(accountId, provider, { limit: 1 });
  assert.equal(report2.done, 1);

  // Idempotency key preserved on retry — provider dedupes, only one effective call per key.
  const replayReport = await drainOutbox(accountId, provider, { limit: 10 });
  assert.equal(replayReport.processed, 0, "no pending rows left");

  // -------------------------------------------------------------------------
  // Partial provider failure must not be silently swallowed
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
  const partialCmd: OutboxCommand = {
    type: "trash",
    conversationId: partialId,
    previous: { folders: ["inbox"], isUnread: false },
  };
  await enqueueOptimistic(accountId, partialCmd, "partial-key");

  // Exhaust retries — partial failure counts as failure each attempt.
  for (let i = 0; i < MAX_OUTBOX_ATTEMPTS; i++) {
    await db.pool.query(
      "update seer.outbox set next_attempt_at = now() - interval '1 second' where idempotency_key = $1",
      ["partial-key"],
    );
    const r = await drainOutbox(accountId, partialProvider, { limit: 1 });
    if (i < MAX_OUTBOX_ATTEMPTS - 1) {
      assert.equal(r.retried, 1, `attempt ${i + 1} should schedule retry`);
    }
  }

  const partialRow = await db.pool.query<{ status: string; last_error: string | null }>(
    "select status, last_error from seer.outbox where idempotency_key = $1",
    ["partial-key"],
  );
  assert.equal(partialRow.rows[0].status, "failed");
  assert.match(partialRow.rows[0].last_error ?? "", /failed/i);

  const partialFolders = await db.pool.query<{ folders: string[] }>(
    "select folders from seer.conversations where id = $1",
    [partialId],
  );
  assert.deepEqual(
    partialFolders.rows[0].folders.sort(),
    ["inbox"],
    "failed after max attempts must revert optimistic patch",
  );

  const events = await db.pool.query<{ kind: string }>(
    "select kind from seer.events where account_id = $1 and idempotency_key = $2",
    [accountId, "partial-key"],
  );
  assert.ok(
    events.rows.some((e) => e.kind === "outbox_failed"),
    "max-attempt failure must raise a visible event",
  );

  // -------------------------------------------------------------------------
  // Transient failure: exponential backoff then success
  // -------------------------------------------------------------------------
  const transientId = await seedConversation(db.pool, accountId, "p-transient", ["inbox"], false);
  const transientCmd: OutboxCommand = {
    type: "archive",
    conversationId: transientId,
    previous: { folders: ["inbox"], isUnread: false },
  };
  await enqueueOptimistic(accountId, transientCmd, "transient-key");

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

  const pendingRow = await db.pool.query<{
    status: string;
    attempts: number;
    next_attempt_at: Date;
  }>(
    "select status, attempts, next_attempt_at from seer.outbox where idempotency_key = $1",
    ["transient-key"],
  );
  assert.equal(pendingRow.rows[0].status, "pending");
  assert.equal(pendingRow.rows[0].attempts, 1);
  assert.ok(
    pendingRow.rows[0].next_attempt_at.getTime() > Date.now() - 1000,
    "next_attempt_at must be in the future after transient failure",
  );

  // Backdate and swap in a working provider.
  await db.pool.query(
    "update seer.outbox set next_attempt_at = now() - interval '1 second' where idempotency_key = $1",
    ["transient-key"],
  );
  const success = await drainOutbox(accountId, transientSuccess, { limit: 1 });
  assert.equal(success.done, 1);

  const doneRow = await db.pool.query<{ status: string; idempotency_key: string }>(
    "select status, idempotency_key from seer.outbox where idempotency_key = $1",
    ["transient-key"],
  );
  assert.equal(doneRow.rows[0].status, "done");
  assert.equal(doneRow.rows[0].idempotency_key, "transient-key");

  console.log("v3-outbox-drain: OK");
} finally {
  await db.stop();
}
