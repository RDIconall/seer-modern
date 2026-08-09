import assert from "node:assert/strict";
import {
  digestThemeRows,
  matterCandidateFor,
} from "../src/lib/inbox/triage-view.ts";

let failures = 0;
function check(name: string, fn: () => void) {
  try {
    fn();
    console.log(`  ok   ${name}`);
  } catch (e) {
    failures += 1;
    console.error(`  FAIL ${name}\n       ${e instanceof Error ? e.message : e}`);
  }
}

console.log("triage view");

check("a deep-read matter disposition becomes a promotion candidate", () => {
  const candidate = matterCandidateFor(
    {
      emailId: "m1",
      threadId: "t1",
      orgUnit: "sales — new requests",
      line: "Roche asked for pricing on the anti-TPO study",
      messageIds: ["m0", "m1"],
    },
    {
      id: "m1",
      threadId: "t1",
      version: 4,
      readAt: "2026-08-09T00:00:00Z",
      kind: "pricing request",
      oneLine: "Roche requested pricing for the anti-TPO study",
      ask: "Send Roche the anti-TPO pricing",
      owner: "you",
      entities: ["Roche"],
      org: { unit: "sales — new requests", confidence: 0.95 },
      importance: 2,
      disposition: "matter",
      matterTitle: "Roche anti-TPO pricing",
      matterWhy: "Roche is waiting for a priced proposal.",
    },
  );

  assert.deepEqual(candidate, {
    title: "Roche anti-TPO pricing",
    why: "Roche is waiting for a priced proposal.",
    orgUnit: "sales — new requests",
    emailIds: ["m0", "m1"],
  });
});

check("records and FYIs never become promotion candidates", () => {
  const row = {
    emailId: "m1",
    threadId: "t1",
    orgUnit: "finance",
    line: "Receipt for $42",
  };
  const base = {
    id: "m1",
    threadId: "t1",
    version: 4,
    readAt: "2026-08-09T00:00:00Z",
    kind: "receipt",
    oneLine: "$42 receipt",
    ask: "nothing — informational",
    owner: "nobody" as const,
    entities: [],
    org: { unit: "finance", confidence: 1 },
    importance: 1,
    matterTitle: "Wrong",
    matterWhy: "Wrong",
  };
  assert.equal(
    matterCandidateFor(row, { ...base, disposition: "record" }),
    null,
  );
  assert.equal(
    matterCandidateFor(row, { ...base, disposition: "fyi" }),
    null,
  );
});

check("a digest theme clears only its own conversations", () => {
  const rows = digestThemeRows(
    {
      emailIds: ["a", "c"],
    },
    [
      { id: "a", threadId: "ta" },
      { id: "b", threadId: "tb" },
      { id: "c", threadId: "tc" },
    ],
  );
  assert.deepEqual(rows, [
    { id: "a", threadId: "ta" },
    { id: "c", threadId: "tc" },
  ]);
});

if (failures) {
  console.error(`\n${failures} failed`);
  process.exit(1);
}
console.log("\nall passed");
