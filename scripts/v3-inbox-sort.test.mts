/**
 * Sorting the Inbox re-orders whole groups: a matter never splits, ties fall
 * back to the oldest group, and the row order handed on (for j/k paging and
 * shift-range selection) is exactly the order shown.
 */
import assert from "node:assert/strict";
import {
  DEFAULT_INBOX_SORT,
  INBOX_SORT_OPTIONS,
  groupInbox,
  nextSort,
  sortFromValue,
  sortGroups,
  sortInboxRows,
  sortLabel,
  sortValue,
} from "../src/components/v3/inbox-groups.ts";
import { nextStepFor } from "../src/lib/v3/mailbox/next-step.ts";
import type { MailboxRow } from "../src/lib/v3/mailbox/types.ts";

function row(
  id: string,
  over: Partial<MailboxRow> & { matterId?: string | null; ask?: string } = {},
): MailboxRow {
  const matterId = over.matterId ?? null;
  const disposition = over.disposition ?? (matterId ? "matter" : "archive");
  return {
    conversationId: id,
    providerConversationId: `p-${id}`,
    senderDisplayName: `Sender ${id}`,
    subject: `Subject ${id}`,
    timestamp: "2026-08-10T10:00:00.000Z",
    isUnread: false,
    snippet: "",
    attachments: [],
    decisionSummary: "Digest",
    priority: null,
    dueDate: null,
    matterTitle: matterId ? "Roche MSA" : null,
    disposition,
    owner: "nobody",
    deleteRank: 0,
    deleteToken: null,
    category: null,
    vetoReasons: [],
    matterId,
    nextStep: nextStepFor({
      disposition,
      matterId,
      ask: over.ask ?? null,
      summary: "Digest",
      userStep: null,
    }),
    groupKey: matterId ? `m:${matterId}` : `c:${id}`,
    groupAt: over.timestamp ?? "2026-08-10T10:00:00.000Z",
    ...over,
  } as MailboxRow;
}

const rows = [
  row("m1-new", { matterId: "M1", ask: "Send redlines", senderDisplayName: "Zed", subject: "Zulu", timestamp: "2026-08-20T10:00:00.000Z", groupAt: "2026-08-01T10:00:00.000Z" }),
  row("m1-old", { matterId: "M1", ask: "Send redlines", timestamp: "2026-08-01T10:00:00.000Z", groupAt: "2026-08-01T10:00:00.000Z" }),
  row("b", { senderDisplayName: "bravo", subject: "Beta", disposition: "delete", timestamp: "2026-08-03T10:00:00.000Z" }),
  row("a", { senderDisplayName: "Alpha", subject: "Apple", disposition: "record", timestamp: "2026-08-10T10:00:00.000Z" }),
  row("c", { senderDisplayName: "Charlie", subject: "Cherry", disposition: "archive", timestamp: "2026-08-06T10:00:00.000Z" }),
];
const groups = groupInbox(rows);
const keys = (sorted: typeof groups) => sorted.map((group) => group.key);

assert.deepEqual(keys(sortGroups(groups, DEFAULT_INBOX_SORT)), ["m:M1", "c:b", "c:c", "c:a"]);
assert.deepEqual(keys(sortGroups(groups, { key: "age", dir: "desc" })), ["c:a", "c:c", "c:b", "m:M1"]);
assert.deepEqual(
  keys(sortGroups(groups, { key: "activity", dir: "desc" })),
  ["m:M1", "c:a", "c:c", "c:b"],
  "a matter's activity is its newest email",
);
assert.deepEqual(
  keys(sortGroups(groups, { key: "from", dir: "asc" })),
  ["c:a", "c:b", "c:c", "m:M1"],
  "names compare without regard to case; a matter sorts by its title",
);
assert.deepEqual(keys(sortGroups(groups, { key: "from", dir: "desc" })), ["m:M1", "c:c", "c:b", "c:a"]);
assert.deepEqual(keys(sortGroups(groups, { key: "subject", dir: "asc" })).slice(0, 3), ["c:a", "c:b", "c:c"]);
const byStep = sortGroups(groups, { key: "step", dir: "asc" });
assert.equal(byStep.length, groups.length);
for (let i = 1; i < byStep.length; i++) {
  assert.ok(byStep[i - 1].step.text.localeCompare(byStep[i].step.text, undefined, { sensitivity: "base", numeric: true }) <= 0);
}

assert.equal(groups.length, 4, "the input is untouched by sorting");
assert.equal(sortInboxRows(rows, DEFAULT_INBOX_SORT), rows, "the default order is the server's order");
const flat = sortInboxRows(rows, { key: "age", dir: "desc" });
assert.deepEqual(
  flat.map((entry) => entry.conversationId),
  ["a", "c", "b", "m1-new", "m1-old"],
  "a matter's emails stay together and flatten in group order",
);
assert.equal(flat.length, rows.length);

// Equal keys fall back to the oldest group.
const ties = [
  row("t2", { senderDisplayName: "Same", timestamp: "2026-08-09T10:00:00.000Z" }),
  row("t1", { senderDisplayName: "Same", timestamp: "2026-08-02T10:00:00.000Z" }),
];
assert.deepEqual(keys(sortGroups(groupInbox(ties), { key: "from", dir: "desc" })), ["c:t1", "c:t2"]);

// Column header clicks and the select agree.
assert.deepEqual(nextSort(DEFAULT_INBOX_SORT, "age"), { key: "age", dir: "desc" });
assert.deepEqual(nextSort(DEFAULT_INBOX_SORT, "from"), { key: "from", dir: "asc" });
assert.deepEqual(nextSort({ key: "from", dir: "asc" }, "from"), { key: "from", dir: "desc" });
for (const option of INBOX_SORT_OPTIONS) {
  assert.deepEqual(sortFromValue(option.value), option.sort);
  assert.equal(sortValue(option.sort), option.value);
  assert.equal(sortLabel(option.sort), option.label);
}
assert.equal(sortFromValue("bogus:asc"), null);
assert.equal(sortFromValue(null), null);

console.log("v3 inbox sort ok");
