/**
 * Gate: a mailbox that still has work chains the next hop; a finished or
 * failed tick does not. Outbox/push rows in a sync report must not look like
 * an unfinished folder.
 *
 * "Still has work" has to mean evidence, not activity. Chaining on any
 * progress at all bought one extra invocation per mailbox per tick whose only
 * job was to find an empty queue — the cost that made ordinary mail look like
 * a usage spike. And no chain may run forever: a hop that keeps claiming
 * progress is capped, then has to wait for the schedule like everyone else.
 */
import assert from "node:assert/strict";
import {
  MAX_CHAINED_HOPS,
  nextHopUrl,
  shouldContinueRead,
  shouldContinueSync,
} from "../src/lib/v2/cron/continue.ts";

assert.equal(
  shouldContinueRead({ decided: 400, queued: 400, limit: 400 }),
  true,
  "a full batch is evidence more mail is waiting",
);
assert.equal(
  shouldContinueRead({ decided: 12, queued: 12, limit: 400 }),
  false,
  "a queue short of the cap was drained by this hop — do not pay for a " +
    "successor that will find nothing",
);
assert.equal(
  shouldContinueRead({ decided: 0, queued: 0, limit: 400 }),
  false,
);
assert.equal(
  shouldContinueRead({ decided: 400, queued: 400, limit: 400, error: "timeout" }),
  false,
);
assert.equal(
  shouldContinueRead({ decided: 400, queued: 400, limit: 400, skipped: "lease" }),
  false,
);
assert.equal(
  shouldContinueRead({ decided: 9 }),
  false,
  "a report with no queue depth must not chain on faith",
);

assert.equal(
  shouldContinueSync([
    { email: "lara@example.com", outbox: { drained: 0 } },
    {
      email: "lara@example.com",
      folder: "inbox",
      pages: 8,
      backfillComplete: false,
    },
  ]),
  true,
  "inbox progress must chain even when the outbox row has no pages",
);

assert.equal(
  shouldContinueSync([
    { email: "lara@example.com", outbox: { drained: 0 } },
    {
      email: "lara@example.com",
      folder: "inbox",
      pages: 3,
      backfillComplete: true,
    },
  ]),
  false,
  "a completed inbox must not keep chaining",
);

assert.equal(
  shouldContinueSync([
    {
      email: "lara@example.com",
      folder: "inbox",
      pages: 2,
      error: "graph 429",
    },
  ]),
  false,
);

assert.equal(
  shouldContinueSync([
    {
      email: "lara@example.com",
      folder: "inbox",
      pages: 0,
      backfillComplete: false,
    },
  ]),
  false,
  "no progress means wait for the next cron, not a tight empty loop",
);

// The hop counter rides on the worker URL and is bounded.
const first = nextHopUrl("https://seer.example/api/v2/sync?accountId=aa");
assert.equal(first, "https://seer.example/api/v2/sync?accountId=aa&hop=1");
assert.equal(
  nextHopUrl(first!),
  "https://seer.example/api/v2/sync?accountId=aa&hop=2",
  "the count carries across invocations rather than restarting",
);
assert.equal(
  nextHopUrl(`https://seer.example/api/v2/read?hop=${MAX_CHAINED_HOPS}`),
  null,
  "the chain stops at the cap instead of running unbounded",
);
assert.equal(
  nextHopUrl("https://seer.example/api/v2/read?hop=nonsense"),
  "https://seer.example/api/v2/read?hop=1",
  "a junk hop count must not disable the cap",
);
assert.equal(nextHopUrl("https://seer.example/api/v2/read?hop=2", 2), null);

console.log("v2-cron-continue: OK");
