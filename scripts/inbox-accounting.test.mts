import assert from "node:assert/strict";
import { buildInboxAccounting } from "../src/lib/inbox/inbox-accounting.ts";

const matter = (
  id: string,
  orgUnit: string,
  emailIds: string[],
) => ({
  id,
  orgUnit,
  emailIds,
});

console.log("inbox accounting");

const accounting = buildInboxAccounting({
  asOf: "2026-08-09T17:00:00Z",
  providerTotal: 9,
  functions: ["sales", "operations"],
  matters: [
    matter("m1", "sales — new requests", ["a", "b"]),
    // b occurs in two matters due to bad upstream data: count it once.
    matter("m2", "sales — contracting", ["b", "c"]),
  ],
  pinned: [matter("signature-queue", "signatures", ["d"])],
  filed: [
    { emailId: "e", threadId: "te", orgUnit: "finance" },
    {
      emailId: "g",
      threadId: "tg",
      orgUnit: "finance",
      messageIds: ["f", "g"],
    },
  ],
  digestIds: ["h", "i"],
});

assert.deepEqual(accounting, {
  asOf: "2026-08-09T17:00:00Z",
  total: 9,
  mapped: 4,
  mappedByCategory: [
    { category: "sales", count: 3 },
    { category: "signatures", count: 1 },
  ],
  triage: 5,
  pending: 0,
});

const short = buildInboxAccounting({
  asOf: "2026-08-09T17:00:00Z",
  providerTotal: 10,
  functions: ["sales", "operations"],
  matters: accounting.mappedByCategory.length
    ? [matter("m1", "sales", ["a"])]
    : [],
  pinned: [],
  filed: [],
  digestIds: [],
});
assert.equal(short.mapped, 1);
assert.equal(short.triage, 0);
assert.equal(short.pending, 9);
assert.equal(short.mapped + short.triage + short.pending, short.total);

console.log("all passed");
