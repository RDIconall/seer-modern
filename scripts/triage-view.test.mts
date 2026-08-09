import assert from "node:assert/strict";
import {
  digestThemeRows,
  matterCandidateFor,
} from "../src/lib/inbox/triage-view.ts";
import { restoreClosureMatter } from "../src/lib/store/closed-matters.ts";

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

check("a matter disposition still surfaces when the model omits its title", () => {
  const candidate = matterCandidateFor(
    {
      emailId: "m2",
      threadId: "t2",
      orgUnit: "board",
      line: "Sandy wants the revised board forecast",
    },
    {
      id: "m2",
      threadId: "t2",
      version: 4,
      readAt: "2026-08-09T00:00:00Z",
      kind: "board request",
      oneLine: "Sandy requested the revised board forecast",
      ask: "Send Sandy the revised forecast",
      owner: "you",
      entities: ["Sandy"],
      org: { unit: "board", confidence: 1 },
      importance: 3,
      disposition: "matter",
    },
  );
  assert.equal(candidate?.title, "Sandy requested the revised board forecast");
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

check("reopening restores the settled snapshot to active matters once", () => {
  const matter = {
    id: "roche-pricing",
    title: "Roche pricing",
    category: "sales",
    orgUnit: "sales — new requests",
    people: [],
    narrative: "Roche is waiting for pricing.",
    nextAction: "Send pricing",
    owner: "you",
    urgency: 2,
    emailIds: ["m1"],
    threadIds: ["t1"],
    updatedAt: "2026-08-09T00:00:00Z",
  };
  const brief = {
    builtAt: "2026-08-09T00:00:00Z",
    summary: "",
    matters: [],
    headlines: [],
    headlineIds: [],
    count: 0,
  };
  const restored = restoreClosureMatter(brief as never, {
    matterId: matter.id,
    titleTokens: ["roche", "pricing"],
    threadIds: ["t1"],
    closedAt: "2026-08-09T00:00:00Z",
    reason: "done",
    by: "user",
    matter,
  });
  assert.equal(restored.matters.length, 1);
  assert.equal(restored.matters[0].id, matter.id);
  assert.equal(
    restoreClosureMatter(restored, {
      matterId: matter.id,
      titleTokens: ["roche", "pricing"],
      threadIds: ["t1"],
      closedAt: "2026-08-09T00:00:00Z",
      reason: "done",
      by: "user",
      matter,
    }).matters.length,
    1,
  );
});

if (failures) {
  console.error(`\n${failures} failed`);
  process.exit(1);
}
console.log("\nall passed");
