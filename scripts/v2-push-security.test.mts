/**
 * Push security helpers and webhook handshake behaviour.
 */
import assert from "node:assert/strict";
import {
  clientStateMatches,
  graphClientState,
  graphClientStateHash,
} from "../src/lib/v2/push/security.ts";
import { setPoolForTesting } from "../src/lib/v2/db/pool.ts";
import { asAccountId } from "../src/lib/v2/db/types.ts";

process.env.SEER_WEBHOOK_PEPPER = "test-pepper-for-push";

const accountId = asAccountId("11111111-1111-4111-8111-111111111111");
const state = graphClientState(accountId);
assert.ok(state.length === 64, "clientState is hex sha256");
assert.equal(clientStateMatches(accountId, state), true);
assert.equal(clientStateMatches(accountId, "nope"), false);
assert.equal(clientStateMatches(accountId, null), false);
assert.notEqual(graphClientStateHash(accountId), state);

// Outlook validation handshake — the route echoes the token as text/plain.
const { POST } = await import("../src/app/api/webhooks/outlook/route.ts");
const validation = await POST(
  new Request(
    "https://example.com/api/webhooks/outlook?validationToken=abc%20123",
    { method: "POST" },
  ),
);
assert.equal(validation.status, 200);
assert.equal(await validation.text(), "abc 123");
assert.match(
  validation.headers.get("content-type") ?? "",
  /text\/plain/,
);

// A temporary database failure must still be acknowledged. Microsoft Graph
// retries non-2xx responses aggressively, while reconciliation recovers mail
// that could not be scheduled during the outage.
setPoolForTesting({
  query: async () => {
    throw new Error("pooler temporarily unavailable");
  },
} as never);
const originalConsoleError = console.error;
console.error = () => {};
try {
  const degraded = await POST(
    new Request("https://example.com/api/webhooks/outlook", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        value: [
          {
            subscriptionId: "graph-subscription",
            clientState: state,
            changeType: "created",
          },
        ],
      }),
    }),
  );
  assert.equal(degraded.status, 200);
  assert.deepEqual(await degraded.json(), {
    ok: true,
    waking: 0,
    deferred: 1,
  });
} finally {
  console.error = originalConsoleError;
  setPoolForTesting(null);
}

console.log("v2-push-security: OK");
