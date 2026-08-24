/**
 * Gate: triage can be worked several conversations at a time.
 *
 * Triage renders through MobileMailboxList at every width, and that component
 * had no selection at all — the reducer with the shift-range rule was wired
 * only into FolderList, which triage never reaches. The only bulk move was
 * "Delete all" on a whole pile, so placing six of forty rows meant six separate
 * gestures. These assertions are about the wiring, because the bug was not a
 * broken rule but a rule that was never connected.
 */
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { MobileMailboxList } from "../src/components/v3/MobileMailboxList.tsx";
import {
  EMPTY_SELECTION,
  reduceSelection,
} from "../src/components/v3/list-selection.ts";
import type { MailboxRow, MailboxView } from "../src/lib/v3/mailbox/types.ts";

const row = (over: Partial<MailboxRow>): MailboxRow => ({
  conversationId: "c",
  providerConversationId: "p",
  senderDisplayName: "Someone",
  subject: "Subject",
  timestamp: "2026-08-17T09:00:00.000Z",
  isUnread: true,
  snippet: "",
  attachments: [],
  decisionSummary: null,
  priority: null,
  dueDate: null,
  matterTitle: null,
  disposition: "matter",
  owner: "nobody",
  deleteRank: 3,
  deleteToken: null,
  category: null,
  vetoReasons: [],
  ...over,
});

const rows = [
  row({ conversationId: "d1", disposition: "delete", deleteToken: "t" }),
  row({ conversationId: "d2", disposition: "delete", deleteToken: "t" }),
  row({ conversationId: "r1", disposition: "record" }),
  row({ conversationId: "m1", disposition: "matter" }),
];

const view: MailboxView = {
  accountId: "a",
  folder: "inbox",
  sort: "triage",
  rows,
  total: rows.length,
  needsYou: 1,
  nextCursor: null,
};

const html = renderToString(
  createElement(MobileMailboxList, {
    view,
    triage: true,
    onOpen() {},
    onCommands: async () => [],
  } as never),
).replace(/<!--[\s\S]*?-->/g, "");

// Every row carries a tick box, and every pile carries a select-all.
const rowBoxes = [...html.matchAll(/aria-label="Select (?!all in)[^"]*"/g)];
assert.equal(rowBoxes.length, rows.length, "every triage row can be ticked");
for (const pile of ["Delete", "Archive", "Atlas"]) {
  assert.match(
    html,
    new RegExp(`aria-label="Select all in ${pile}"`),
    `the ${pile} pile can be taken whole`,
  );
}

// The toolbar is not drawn until something is ticked: a list that always shows
// bulk actions is a spreadsheet.
assert.doesNotMatch(html, /compact-mail-bulk/);
assert.doesNotMatch(html, /selected<\/span>/);

// --- the selection rule itself ------------------------------------------------

const ids = rows.map((r) => r.conversationId);

// A plain tick sets the anchor; a shift tick ranges from it and LEAVES it, so
// repeated shift-clicks re-range from the same origin rather than walking down.
const first = reduceSelection(EMPTY_SELECTION, { kind: "row", index: 0, shift: false }, ids);
assert.deepEqual([...first.ids], ["d1"]);
assert.equal(first.anchor, 0);

const ranged = reduceSelection(first, { kind: "row", index: 2, shift: true }, ids);
assert.deepEqual([...ranged.ids].sort(), ["d1", "d2", "r1"]);
assert.equal(ranged.anchor, 0, "the anchor survives a range");

// A range crosses a pile boundary, because the ids are the piles as READ.
const wider = reduceSelection(first, { kind: "row", index: 3, shift: true }, ids);
assert.equal(wider.ids.size, 4, "a range spans piles in reading order");

// One pile can be taken whole without touching the others.
const pile = reduceSelection(
  EMPTY_SELECTION,
  { kind: "group", ids: ["d1", "d2"], checked: true },
  ids,
);
assert.deepEqual([...pile.ids].sort(), ["d1", "d2"]);
assert.equal(
  reduceSelection(pile, { kind: "group", ids: ["d1", "d2"], checked: false }, ids).ids.size,
  0,
);

// A tick on a row that has since been placed must not act on something else.
const pruned = reduceSelection(pile, { kind: "prune" }, ["d2", "r1"]);
assert.deepEqual([...pruned.ids], ["d2"]);

// --- the wiring ---------------------------------------------------------------

const source = await fs.readFile("src/components/v3/MobileMailboxList.tsx", "utf8");
assert.match(source, /reduceSelection/, "triage uses the tested reducer");
assert.match(source, /kind: "row"/);
assert.match(source, /kind: "group"/);
assert.match(source, /kind: "prune"/);
assert.match(source, /Escape/, "Escape drops the selection");
// The bulk toolbar offers the same three destinations a single row offers.
for (const destination of ["matterCommand", "triageArchiveCommand", "triageDeleteCommand"]) {
  assert.match(source, new RegExp(destination));
}

const rowSource = await fs.readFile("src/components/v3/MobileMailRow.tsx", "utf8");
assert.match(rowSource, /onToggleSelect/);
assert.match(
  rowSource,
  /if \(selecting\) return;/,
  "a swipe acts on one row, so gestures stand down during a selection",
);
assert.match(
  rowSource,
  /shiftHeld/,
  "the shift key is read from the click, not the change event",
);

const css = await fs.readFile("src/app/globals.css", "utf8");
assert.match(css, /\.mobile-mail-select\b/, "the tick box is styled");
assert.match(css, /\.compact-mail-bulk\b/, "the bulk toolbar is styled");

console.log("v3-triage-multiselect: OK");
