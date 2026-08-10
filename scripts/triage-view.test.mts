import assert from "node:assert/strict";
import {
  digestThemeRows,
  digestWithoutHomedThreads,
  matterCandidateFor,
  matterFromRead,
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

check("a promoted read becomes a matter, not a question in Triage", () => {
  const matter = matterFromRead({
    matterId: "read:t1",
    candidate: {
      title: "Roche anti-TPO pricing",
      why: "Roche is waiting for a priced proposal.",
      orgUnit: "sales — new requests",
      emailIds: ["m0", "m1"],
    },
    row: {
      emailId: "m1",
      threadId: "t1",
      from: "Anna Roche",
      line: "Anna Roche — pricing for the anti-TPO study",
      suggestion: "Send Roche the anti-TPO pricing",
      at: "2026-08-09T00:00:00Z",
      count: 2,
    },
    understanding: {
      id: "m1",
      threadId: "t1",
      version: 4,
      readAt: "2026-08-09T00:00:00Z",
      kind: "pricing request",
      oneLine: "Roche requested pricing",
      ask: "Send Roche the anti-TPO pricing",
      owner: "you",
      entities: ["Roche"],
      org: { unit: "sales — new requests", confidence: 0.95 },
      importance: 3,
      disposition: "matter",
    },
    at: "2026-08-09T01:00:00Z",
  });

  assert.equal(matter.id, "read:t1");
  assert.equal(matter.title, "Roche anti-TPO pricing");
  assert.equal(matter.nextAction, "Send Roche the anti-TPO pricing");
  assert.equal(matter.owner, "you");
  assert.equal(matter.status, "active");
  assert.deepEqual(matter.emailIds, ["m0", "m1"]);
  assert.deepEqual(matter.threadIds, ["t1"]);
  assert.equal(matter.emails?.[0].count, 2);
});

check("a promoted read whose ask is nothing still lands with no next action", () => {
  const matter = matterFromRead({
    matterId: "read:t2",
    candidate: {
      title: "Site contract renewal",
      why: "The contract lapses this quarter.",
      orgUnit: "legal",
      emailIds: ["m2"],
    },
    row: {
      emailId: "m2",
      threadId: "t2",
      from: "Legal",
      line: "Legal — contract renewal",
    },
    understanding: {
      id: "m2",
      threadId: "t2",
      version: 4,
      readAt: "2026-08-09T00:00:00Z",
      kind: "contract",
      oneLine: "Contract renewal",
      ask: "nothing — informational",
      owner: "them",
      entities: [],
      org: { unit: "legal", confidence: 1 },
      importance: 2,
      disposition: "matter",
    },
    at: "2026-08-09T01:00:00Z",
  });

  assert.equal(matter.nextAction, "none — yours to define");
  assert.equal(matter.status, "waiting");
});

check("a reopened promotion carries the reason it came back", () => {
  const matter = matterFromRead({
    matterId: "read:t3",
    candidate: {
      title: "Abbott audit follow-up",
      why: "Abbott replied after the audit closed.",
      orgUnit: "quality",
      emailIds: ["m3"],
    },
    row: { emailId: "m3", threadId: "t3", from: "Abbott", line: "Abbott — audit" },
    reopenedBecause: "New mail after you closed this (done)",
    at: "2026-08-09T01:00:00Z",
  });

  assert.equal(matter.status, "reopened");
  assert.equal(matter.statusWhy, "New mail after you closed this (done)");
});

check("a conversation in a matter never also sits in Triage", () => {
  const digest = digestWithoutHomedThreads(
    {
      summary: "",
      themes: [
        {
          theme: "Newsletters",
          line: "Weekly reading.",
          emailIds: ["m-live", "m-noise"],
          items: [
            { id: "m-live", threadId: "t-live", line: "FYI reply", at: "" },
            { id: "m-noise", threadId: "t-noise", line: "Newsletter", at: "" },
          ],
        },
      ],
    },
    new Set(["t-live"]),
    new Map([
      ["m-live", "t-live"],
      ["m-noise", "t-noise"],
    ]),
  );

  assert.deepEqual(digest.themes[0].emailIds, ["m-noise"]);
  assert.deepEqual(
    digest.themes[0].items?.map((i) => i.id),
    ["m-noise"],
  );
});

check("a theme left with nothing of its own disappears", () => {
  const digest = digestWithoutHomedThreads(
    {
      summary: "",
      themes: [
        {
          theme: "Newsletters",
          line: "Weekly reading.",
          emailIds: ["m-live"],
          items: [{ id: "m-live", threadId: "t-live", line: "FYI", at: "" }],
        },
      ],
    },
    new Set(["t-live"]),
    new Map([["m-live", "t-live"]]),
  );
  assert.equal(digest.themes.length, 0);
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
