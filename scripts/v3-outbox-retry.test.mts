/**
 * Outbox retry classification unit gate.
 */
import assert from "node:assert/strict";
import { ProviderHttpError } from "../src/lib/v2/providers/http.ts";
import { classifyDrainError } from "../src/lib/v3/outbox/retry.ts";

assert.equal(classifyDrainError(new ProviderHttpError(401, "gmail", "auth")), "permanent");
assert.equal(classifyDrainError(new ProviderHttpError(403, "gmail", "forbidden")), "permanent");
assert.equal(classifyDrainError(new ProviderHttpError(429, "gmail", "rate")), "transient");
assert.equal(classifyDrainError(new ProviderHttpError(503, "gmail", "down")), "transient");
assert.equal(classifyDrainError(new ProviderHttpError(404, "gmail", "missing")), "reconcile");
assert.equal(classifyDrainError(new Error("network timeout")), "transient");
assert.equal(classifyDrainError(new Error("request unauthorized")), "permanent");

console.log("v3-outbox-retry: OK");
