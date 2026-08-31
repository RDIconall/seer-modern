/**
 * Gate: a mailbox that still has work chains the next hop; a finished or
 * failed tick does not. Outbox/push rows in a sync report must not look like
 * an unfinished folder.
 */
import assert from "node:assert/strict";
import {
  shouldContinueRead,
  shouldContinueSync,
} from "../src/lib/v2/cron/continue.ts";

assert.equal(shouldContinueRead({ decided: 12 }), true);
assert.equal(shouldContinueRead({ decided: 0 }), false);
assert.equal(shouldContinueRead({ decided: 4, error: "timeout" }), false);
assert.equal(shouldContinueRead({ decided: 4, skipped: "lease" }), false);

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

console.log("v2-cron-continue: OK");
