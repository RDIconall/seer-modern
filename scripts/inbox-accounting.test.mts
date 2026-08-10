import assert from "node:assert/strict";
import { buildInboxAccounting } from "../src/lib/inbox/inbox-accounting.ts";
import {
  applyTriageClear,
  planTriageClear,
} from "../src/lib/inbox/triage-clear.ts";

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

const mixedBrief = {
  builtAt: "2026-08-09T17:00:00Z",
  summary: "",
  matters: [
    {
      id: "active",
      orgUnit: "sales",
      emailIds: ["a"],
      threadIds: ["t-active"],
    },
  ],
  pinned: [],
  headlines: [
    { id: "d1", threadId: "t-file", line: "Routine update" },
    { id: "noise", threadId: "t-active", line: "Noise sibling" },
  ],
  headlineIds: [
    { id: "d1", threadId: "t-file" },
    { id: "noise", threadId: "t-active" },
  ],
  functions: ["sales"],
  totalInbox: 5,
  providerTotal: { messages: 5, threads: 2 },
  filed: [
    {
      emailId: "f2",
      threadId: "t-file",
      orgUnit: "finance",
      messageIds: ["f1", "f2"],
      count: 2,
      line: "Invoice record",
    },
  ],
  digest: {
    summary: "",
    themes: [
      {
        theme: "Updates",
        line: "Routine updates",
        emailIds: ["d1", "noise"],
        items: [
          { id: "d1", threadId: "t-file", line: "Routine update", at: "" },
          {
            id: "noise",
            threadId: "t-active",
            line: "Noise sibling",
            at: "",
          },
        ],
      },
    ],
  },
};

const plan = planTriageClear(mixedBrief as never, [
  { id: "f2", threadId: "t-file" },
  { id: "noise", threadId: "t-active" },
]);
assert.deepEqual(plan, [
  { id: "f2", threadId: "t-file" },
  // Active matter shares this thread: archive only the noise message.
  { id: "noise" },
]);

const cleared = applyTriageClear(mixedBrief as never, plan);
assert.equal(cleared.matters.length, 1);
assert.equal(cleared.filed?.length, 0);
assert.equal(cleared.digest?.themes.length, 0);
assert.equal(cleared.accounting?.total, 1);
assert.equal(cleared.accounting?.mapped, 1);
assert.equal(cleared.accounting?.triage, 0);
assert.equal(
  (cleared.accounting?.mapped ?? 0) +
    (cleared.accounting?.triage ?? 0) +
    (cleared.accounting?.pending ?? 0),
  cleared.accounting?.total,
);
