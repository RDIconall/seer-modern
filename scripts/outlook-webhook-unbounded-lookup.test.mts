/**
 * Outlook push webhook must not turn an anonymous notification list into
 * unbounded mail_push_subscriptions lookups.
 *
 * These tests fail while that behavior is present. They are the spec for the
 * fix:
 * - A clientState that cannot match graphClientState (missing, empty, or not
 *   64 hex characters) is rejected before any database lookup.
 * - One request looks up at most MAX_NOTIFICATIONS_PER_REQUEST subscription
 *   ids. Ids past that prefix are not queried. A non-2xx response performs
 *   no lookup at all.
 * - A notification whose client state matches the looked-up account still
 *   claims a wake for that same account, with one subscription select.
 *
 * Gmail push (src/app/api/webhooks/gmail/route.ts) reads a single Pub/Sub
 * message, not a caller-sized list, and is not covered here.
 *
 * Run: tsx scripts/outlook-webhook-unbounded-lookup.test.mts
 */
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { setPoolForTesting } from "../src/lib/v2/db/pool.ts";
import { asAccountId } from "../src/lib/v2/db/types.ts";
import { graphClientState } from "../src/lib/v2/push/security.ts";

process.env.SEER_WEBHOOK_PEPPER = "placeholder-webhook-pepper";

const { POST } = await import("../src/app/api/webhooks/outlook/route.ts");

/** Bound the fix must enforce. Larger batches are the attack. */
const MAX_NOTIFICATIONS_PER_REQUEST = 16;

const KNOWN_SUBSCRIPTION = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const KNOWN_ACCOUNT = "11111111-1111-4111-8111-111111111111";
const KNOWN_ROW = {
  account_id: KNOWN_ACCOUNT,
  provider: "microsoft",
  gmail_history_id: null,
  gmail_watch_expires_at: null,
  graph_subscription_id: KNOWN_SUBSCRIPTION,
  graph_client_state_hash: null,
  graph_expires_at: null,
  last_notification_at: null,
  last_wake_at: null,
  last_error: null,
};

type RecordedQuery = { text: string; values: unknown[] };

type Harness = {
  pool: Pool;
  queries: RecordedQuery[];
  acquired: () => number;
  releaseHeld: () => void;
  end: () => Promise<void>;
};

function isPlausibleClientState(value: unknown): boolean {
  return typeof value === "string" && /^[0-9a-f]{64}$/i.test(value);
}

function resultFor(text: string, values: unknown[]) {
  if (text.includes("graph_subscription_id")) {
    if (values[0] === KNOWN_SUBSCRIPTION) {
      return { rows: [KNOWN_ROW], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  }
  if (text.includes("last_notification_at")) {
    // Dedupe the wake so next/server `after` is not required in this test.
    return { rows: [{ ok: false }], rowCount: 1 };
  }
  return { rows: [], rowCount: 0 };
}

/**
 * Real pg-pool (the pool db() constructs) with a client that never opens a
 * socket. Pool.query checks a client out and does not release it until the
 * client callback runs, which is the hold the webhook keeps during each lookup.
 */
function createHarness(options: { max: number; hold: boolean }): Harness {
  const queries: RecordedQuery[] = [];
  let acquired = 0;
  const held: Array<(err: Error | null, res: unknown) => void> = [];
  let autoFinish = !options.hold;

  class ScriptClient extends EventEmitter {
    _queryable = true;
    _ending = false;
    connect(cb: (err: Error | null) => void) {
      cb(null);
    }
    ref() {}
    unref() {}
    end(cb?: () => void) {
      this._ending = true;
      cb?.();
    }
    query(
      text: string,
      values: unknown[] | ((err: Error | null, res: unknown) => void),
      cb?: (err: Error | null, res: unknown) => void,
    ) {
      if (typeof values === "function") {
        cb = values;
        values = [];
      }
      const recorded = { text: String(text), values: values ?? [] };
      queries.push(recorded);
      const finish = () => {
        cb?.(null, resultFor(recorded.text, recorded.values));
      };
      // Only subscription lookups stay checked out. A probe query must be
      // able to take a free client without waiting on the test.
      if (autoFinish || !recorded.text.includes("mail_push_subscriptions")) {
        finish();
        return;
      }
      held.push(finish);
    }
  }

  const pool = new Pool({
    max: options.max,
    connectionTimeoutMillis: 200,
    idleTimeoutMillis: 1_000,
    allowExitOnIdle: true,
    Client: ScriptClient,
  } as never);
  pool.on("acquire", () => {
    acquired += 1;
  });

  return {
    pool,
    queries,
    acquired: () => acquired,
    releaseHeld: () => {
      autoFinish = true;
      const pending = held.splice(0);
      for (const finish of pending) finish();
    },
    end: async () => {
      autoFinish = true;
      const pending = held.splice(0);
      for (const finish of pending) finish();
      await pool.end();
    },
  };
}

function subscriptionIdsQueried(queries: RecordedQuery[]): string[] {
  const ids: string[] = [];
  for (const query of queries) {
    if (!query.text.includes("graph_subscription_id")) continue;
    for (const value of query.values) {
      if (typeof value === "string") ids.push(value);
      else if (Array.isArray(value)) {
        for (const item of value) {
          if (typeof item === "string") ids.push(item);
        }
      }
    }
  }
  return ids;
}

function note(
  clientState: string | undefined,
  subscriptionId = randomUUID(),
): {
  subscriptionId: string;
  clientState?: string;
  changeType: string;
} {
  const entry: {
    subscriptionId: string;
    clientState?: string;
    changeType: string;
  } = { subscriptionId, changeType: "created" };
  if (clientState !== undefined) entry.clientState = clientState;
  return entry;
}

function many(
  count: number,
  clientState: string | undefined,
): ReturnType<typeof note>[] {
  return Array.from({ length: count }, () => note(clientState));
}

async function postNotifications(
  entries: ReturnType<typeof note>[],
): Promise<{ status: number; body: Record<string, unknown> | null }> {
  const response = await POST(
    new Request("https://example.com/api/webhooks/outlook", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ value: entries }),
    }),
  );
  const text = await response.text();
  let body: Record<string, unknown> | null = null;
  if (text) {
    try {
      body = JSON.parse(text) as Record<string, unknown>;
    } catch {
      body = null;
    }
  }
  return { status: response.status, body };
}

function assertLookupBounds(
  entries: ReturnType<typeof note>[],
  queries: RecordedQuery[],
  status: number,
) {
  const lookedUp = subscriptionIdsQueried(queries);
  if (status !== 200) {
    assert.equal(
      lookedUp.length,
      0,
      `status ${status} still looked up ${lookedUp.length} subscription ids`,
    );
  }
  assert.ok(
    lookedUp.length <= MAX_NOTIFICATIONS_PER_REQUEST,
    `looked up ${lookedUp.length} subscription ids; cap is ${MAX_NOTIFICATIONS_PER_REQUEST}`,
  );
  const allowed = new Set(
    entries
      .slice(0, MAX_NOTIFICATIONS_PER_REQUEST)
      .map((entry) => entry.subscriptionId),
  );
  for (const id of lookedUp) {
    assert.ok(
      allowed.has(id),
      `subscription ${id} was looked up past the first ${MAX_NOTIFICATIONS_PER_REQUEST} notifications`,
    );
  }
  for (const entry of entries) {
    if (isPlausibleClientState(entry.clientState)) continue;
    assert.equal(
      lookedUp.includes(entry.subscriptionId),
      false,
      `subscription ${entry.subscriptionId} was looked up without a plausible client state`,
    );
  }
  const updates = queries.filter((query) =>
    query.text.includes("last_notification_at"),
  );
  const accounted = new Set(lookedUp);
  for (const update of updates) {
    const accountId = update.values[0];
    assert.equal(accountId, KNOWN_ACCOUNT);
    assert.ok(
      accounted.has(KNOWN_SUBSCRIPTION),
      "claimWake ran without a lookup of the known subscription",
    );
  }
}

async function withHarness(
  options: { max: number; hold: boolean },
  run: (harness: Harness) => Promise<void>,
) {
  const harness = createHarness(options);
  setPoolForTesting(harness.pool);
  try {
    await run(harness);
  } finally {
    setPoolForTesting(null);
    await harness.end();
  }
}

const failures: string[] = [];

async function check(name: string, run: () => Promise<void>) {
  try {
    await run();
    console.log(`ok ${name}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    failures.push(`${name}: ${message}`);
    console.error(`FAIL ${name}: ${message}`);
  }
}

await check(
  "omitted or impossible client state does not look up subscription ids",
  async () => {
    const entries = [
      ...many(80, undefined),
      ...many(80, ""),
      ...many(40, "short"),
      ...many(40, "z".repeat(64)),
    ];
    await withHarness({ max: 5, hold: false }, async (harness) => {
      const { status, body } = await postNotifications(entries);
      assertLookupBounds(entries, harness.queries, status);
      assert.equal(subscriptionIdsQueried(harness.queries).length, 0);
      assert.equal(harness.acquired(), 0);
      if (status === 200) assert.equal(body?.waking, 0);
    });
  },
);

await check(
  "a list longer than the cap does not look up every plausible subscription id",
  async () => {
    const entries = many(200, "ab".repeat(32));
    await withHarness({ max: 5, hold: false }, async (harness) => {
      const { status, body } = await postNotifications(entries);
      assertLookupBounds(entries, harness.queries, status);
      assert.ok(subscriptionIdsQueried(harness.queries).length < entries.length);
      if (status === 200) assert.equal(body?.waking, 0);
    });
  },
);

await check(
  "a short list still skips entries whose client state cannot match",
  async () => {
    const plausible = note("cd".repeat(32));
    const entries = [note(undefined), note(""), note("nope"), plausible];
    await withHarness({ max: 5, hold: false }, async (harness) => {
      const { status } = await postNotifications(entries);
      assertLookupBounds(entries, harness.queries, status);
      assert.deepEqual(subscriptionIdsQueried(harness.queries), [
        plausible.subscriptionId,
      ]);
    });
  },
);

await check(
  "parallel anonymous lists do not hold the shared pool",
  async () => {
    const poolMax = 2;
    await withHarness({ max: poolMax, hold: true }, async (harness) => {
      const first = postNotifications(many(30, undefined));
      const second = postNotifications(many(30, ""));
      const settled = Promise.all([first, second]);
      const started = Date.now();
      let observed: "held" | "idle" = "idle";
      while (Date.now() - started < 250) {
        if (harness.acquired() >= poolMax) {
          observed = "held";
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      const attackAcquired = harness.acquired();
      const probe = harness.pool
        .query("select 1")
        .then(() => "granted" as const)
        .catch(() => "rejected" as const);
      const probeResult = await Promise.race([
        probe,
        new Promise<"blocked">((resolve) =>
          setTimeout(() => resolve("blocked"), 300),
        ),
      ]);
      try {
        assert.equal(
          observed,
          "idle",
          `anonymous notifications checked out ${attackAcquired} pooled connections`,
        );
        assert.equal(attackAcquired, 0);
        assert.equal(probeResult, "granted");
        assert.equal(subscriptionIdsQueried(harness.queries).length, 0);
      } finally {
        harness.releaseHeld();
        await settled;
        await probe;
      }
    });
  },
);

await check(
  "a matching client state looks up that subscription once and claims the same account",
  async () => {
    const secret = graphClientState(asAccountId(KNOWN_ACCOUNT));
    const entries = [note(secret, KNOWN_SUBSCRIPTION)];
    await withHarness({ max: 5, hold: false }, async (harness) => {
      const { status, body } = await postNotifications(entries);
      assert.equal(status, 200);
      assert.equal(body?.ok, true);
      const lookedUp = subscriptionIdsQueried(harness.queries);
      assert.deepEqual(lookedUp, [KNOWN_SUBSCRIPTION]);
      const updates = harness.queries.filter((query) =>
        query.text.includes("last_notification_at"),
      );
      assert.equal(updates.length, 1);
      assert.equal(updates[0]?.values[0], KNOWN_ACCOUNT);
    });
  },
);

await check(
  "a wrong secret for a known subscription does not claim a wake",
  async () => {
    const entries = [note("cd".repeat(32), KNOWN_SUBSCRIPTION)];
    await withHarness({ max: 5, hold: false }, async (harness) => {
      const { status, body } = await postNotifications(entries);
      assert.equal(status, 200);
      assert.equal(body?.waking, 0);
      assert.deepEqual(subscriptionIdsQueried(harness.queries), [
        KNOWN_SUBSCRIPTION,
      ]);
      assert.equal(
        harness.queries.filter((query) =>
          query.text.includes("last_notification_at"),
        ).length,
        0,
      );
    });
  },
);

await check(
  "a list at the cap of unknown plausible ids is fully looked up and does not wake",
  async () => {
    const entries = many(MAX_NOTIFICATIONS_PER_REQUEST, "ef".repeat(32));
    await withHarness({ max: 5, hold: false }, async (harness) => {
      const { status, body } = await postNotifications(entries);
      assert.equal(status, 200);
      assert.equal(body?.waking, 0);
      assert.deepEqual(
        subscriptionIdsQueried(harness.queries),
        entries.map((entry) => entry.subscriptionId),
      );
    });
  },
);

if (failures.length > 0) {
  console.error(
    `\n${failures.length} outlook webhook lookup assertion(s) failed`,
  );
  process.exitCode = 1;
} else {
  console.log("outlook-webhook-unbounded-lookup: OK");
}
