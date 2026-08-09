import assert from "node:assert/strict";
import { buildExportRows, toCsv } from "../src/lib/inbox/export.ts";
import type { Brief } from "../src/lib/inbox/matters.ts";

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

const brief = {
  builtAt: "2026-08-09T12:00:00Z",
  summary: "",
  functions: ["sales", "quality"],
  matters: [
    {
      id: "m1",
      title: "Roche anti-TPO pricing",
      category: "read",
      orgUnit: "sales — new requests",
      people: [],
      narrative: "Roche is waiting on pricing.",
      nextAction: "Send pricing",
      owner: "you",
      urgency: 3,
      emails: [
        {
          id: "e1",
          threadId: "t1",
          from: "Anna Roche",
          line: "Anna Roche — pricing for anti-TPO",
          suggestion: "Send pricing",
          at: "2026-08-08T10:00:00Z",
          count: 3,
        },
      ],
      emailIds: ["e0", "e1", "e2"],
      threadIds: ["t1"],
      updatedAt: "2026-08-09T12:00:00Z",
    },
  ],
  pinned: [],
  headlines: [],
  headlineIds: [{ id: "d1", threadId: "t9" }],
  filed: [
    {
      emailId: "f1",
      threadId: "t5",
      orgUnit: "quality — SOPs",
      line: "Receipt for the audit fee",
      suggestion: "Keep as record",
      count: 2,
      at: "2026-08-07T09:00:00Z",
    },
  ],
  digest: {
    summary: "",
    themes: [
      {
        theme: "Slack notifications",
        line: "40 messages, none ask you for anything.",
        emailIds: ["d1"],
        items: [
          {
            id: "d1",
            threadId: "t9",
            line: "Someone mentioned you in #general",
            at: "2026-08-09T08:00:00Z",
          },
        ],
      },
    ],
  },
} as unknown as Brief;

console.log("inbox export");

check("every placement appears, one row per conversation", () => {
  const rows = buildExportRows(brief, {
    e1: { disposition: "matter", owner: "you" },
    f1: { disposition: "record", owner: "nobody" },
    d1: { disposition: "disposable", owner: "nobody" },
  });
  assert.equal(rows.length, 3);
  assert.deepEqual(
    rows.map((r) => r.placement),
    ["Atlas — matter", "Triage — close out", "Triage — delete"],
  );
});

check("a matter row carries its title, function and message count", () => {
  const row = buildExportRows(brief)[0];
  assert.equal(row.group, "Roche anti-TPO pricing");
  assert.equal(row.category, "sales");
  assert.equal(row.orgUnit, "sales — new requests");
  assert.equal(row.messages, 3);
  assert.equal(row.threadId, "t1");
});

check("a filed record rolls up to its function", () => {
  const row = buildExportRows(brief)[1];
  assert.equal(row.category, "quality");
  assert.equal(row.messages, 2);
});

check("a delete row names its digest category", () => {
  const row = buildExportRows(brief)[2];
  assert.equal(row.group, "Slack notifications");
  assert.equal(row.nextAction, "Delete");
});

check("the deep read's verdict is carried through", () => {
  const rows = buildExportRows(brief, {
    e1: { disposition: "matter" },
    d1: { disposition: "disposable" },
  });
  assert.equal(rows[0].disposition, "matter");
  assert.equal(rows[2].disposition, "disposable");
});

check("commas and quotes in a summary cannot break the CSV", () => {
  const csv = toCsv([
    {
      placement: "Atlas — matter",
      group: 'He said "yes", then left',
      category: "sales",
      orgUnit: "sales",
      subUnit: "",
      from: "A, B",
      summary: "line one\nline two",
      nextAction: "",
      disposition: "",
      owner: "",
      messages: 1,
      lastAt: "",
      threadId: "t1",
      messageId: "m1",
    },
  ]);
  const [header, row] = csv.split("\r\n");
  assert.ok(header.startsWith("Placement,"));
  assert.ok(row.includes('"He said ""yes"", then left"'));
  assert.ok(row.includes('"A, B"'));
  assert.ok(row.includes('"line one\nline two"'));
});

if (failures) {
  console.error(`\n${failures} failed`);
  process.exit(1);
}
console.log("\nall passed");
