import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { MailboxView } from "../src/lib/v3/mailbox/types.ts";
import {
  appendPage,
  prefetchAdjacentIds,
  viewForFolder,
} from "../src/components/v3/mailbox-state.ts";

const view = (folder: MailboxView["folder"], ids: string[]): MailboxView => ({
  accountId: "test-account",
  folder,
  sort: "date",
  rows: ids.map((conversationId) => ({
    conversationId,
    providerConversationId: `provider-${conversationId}`,
    senderDisplayName: "Sender",
    subject: conversationId,
    timestamp: "2026-08-11T00:00:00.000Z",
    isUnread: false,
    snippet: "",
    attachments: [],
    decisionSummary: null,
    priority: null,
    dueDate: null,
    matterTitle: null,
    disposition: "pending",
    deleteRank: 4,
    deleteToken: null,
    category: null,
  })),
  total: ids.length,
  nextCursor: null,
});

assert.equal(viewForFolder(view("inbox", ["inbox-1"]), "sent"), null);
assert.equal(viewForFolder(null, "sent"), null);
assert.equal(viewForFolder(view("sent", ["sent-1"]), "sent")?.folder, "sent");

assert.deepEqual(
  prefetchAdjacentIds(view("inbox", ["a", "b", "c"]), "b"),
  ["a", "b", "c"],
);
assert.deepEqual(
  prefetchAdjacentIds(view("inbox", ["a", "b", "c"]), "a"),
  ["a", "b"],
);
assert.deepEqual(
  prefetchAdjacentIds(view("inbox", ["a", "b", "c"]), "missing"),
  [],
);

// --- reading a queue to the end ---------------------------------------------
//
// Triage counts its piles from the rows it holds, so a list that stops at one
// page reports a Delete pile of one page and grows another one the moment it
// is cleared. Pages join; the tail's cursor and totals win.
{
  const first = { ...view("inbox", ["a", "b"]), nextCursor: "cursor-1" };
  const second = { ...view("inbox", ["c", "d"]), nextCursor: null, total: 4 };
  const joined = appendPage(first, second);
  assert.deepEqual(
    joined.rows.map((row) => row.conversationId),
    ["a", "b", "c", "d"],
    "later pages append after the rows already on screen",
  );
  assert.equal(joined.nextCursor, null, "the tail's cursor is the list's cursor");
  assert.equal(joined.total, 4);

  // Mail that moved between two reads must not arrive twice: one id, one row,
  // one command when the pile is swept.
  const overlapping = appendPage(first, {
    ...view("inbox", ["b", "c"]),
    nextCursor: null,
  });
  assert.deepEqual(
    overlapping.rows.map((row) => row.conversationId),
    ["a", "b", "c"],
  );
}

// The hook must actually follow the cursor for triage, and stop for a folder.
{
  const source = readFileSync(
    new URL("../src/components/v3/useMailbox.ts", import.meta.url),
    "utf8",
  );
  assert.match(source, /const TRIAGE_PAGE = \d+/, "triage reads in pages");
  assert.match(source, /MAX_TRIAGE_PAGES/, "and cannot page forever");
  assert.match(
    source,
    /before = json\.view\.nextCursor/,
    "each page starts where the last one ended",
  );
  assert.match(
    source,
    /if \(sort !== "triage" \|\| !before\) break/,
    "a folder stops at one page; triage stops when the queue runs out",
  );
  assert.doesNotMatch(
    source,
    /limit=50/,
    "the page size is not hard-coded into the request",
  );
}

console.log("v3-mailbox-state: OK");
