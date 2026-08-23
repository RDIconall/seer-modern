/**
 * Inbox triage sort: group headings, token-gated delete, and select-all
 * indeterminate state — all rendered from server-shaped mailbox rows.
 */
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { FolderList } from "../src/components/v3/FolderList.tsx";
import {
  v3Preview,
  v3TriageInboxView,
} from "../src/app/dev/preview/v3-sample.ts";

const noop = async () => [{ ok: true, replayed: false }];

const dateHtml = renderToString(
  createElement(FolderList, {
    view: v3Preview.mailbox.inbox,
    refreshing: false,
    sort: "date",
    onSortChange: () => {},
    onOpen: () => {},
    onPrefetch: () => {},
    onCommands: noop,
  }),
);

// The inbox is plain: mail in the order it arrived, and no sort control, since
// triage is a tab of its own now.
assert.match(dateHtml, /Inbox/);
assert.doesNotMatch(dateHtml, /Most likely to delete/);
assert.doesNotMatch(dateHtml, /Ready to clear/);
assert.doesNotMatch(dateHtml, /Filed for the record/);
assert.doesNotMatch(dateHtml, /Not read yet/);
assert.match(dateHtml, /No preview available|Automated product usage digest|countersignature/i);

const triageHtml = renderToString(
  createElement(FolderList, {
    view: v3TriageInboxView,
    refreshing: false,
    sort: "triage",
    onSortChange: () => {},
    onOpen: () => {},
    onPrefetch: () => {},
    onCommands: noop,
  }),
);

// The ledger reports only completed three-way classifications. Model failures
// are a processing count, never a fourth destination.
assert.match(triageHtml, /mail-list-ledger/);
const triageText = triageHtml.replace(/<!--[\s\S]*?-->/g, "");
assert.match(
  triageText,
  new RegExp(`${v3TriageInboxView.total} classified`),
  "the ledger reports completed classifications",
);

assert.match(triageHtml, /Ready to clear/);
assert.match(triageHtml, /Filed for the record/);
assert.doesNotMatch(triageHtml, /Needs you/);
assert.doesNotMatch(triageHtml, /Live matters/);
assert.doesNotMatch(triageHtml, /Not read yet/);

/**
 * The clear pile says what it will not take. A user about to sweep several
 * dozen things needs to see that a letter written to them by name was held
 * back, and by whom — the reassurance is worthless if it is generic.
 */
assert.match(triageHtml, /mail-list-held/, "the clear pile carries the held-back note");
assert.match(triageHtml, /Sadanand Palekar/, "the held-back note names the sender");
assert.match(triageHtml, /never swept/);
// It belongs to the pile it was pulled out of, not to the pile it landed in.
const heldAt = triageHtml.indexOf("mail-list-held");
const archiveAt = triageHtml.indexOf("Filed for the record");
assert.ok(heldAt > -1 && archiveAt > -1 && heldAt < archiveAt,
  "the note sits under the clear pile, above Archive");
assert.match(triageHtml, /Seer cleared these for deletion/);
assert.match(triageHtml, /IT &amp; software notices|IT & software notices/);
assert.match(triageHtml, /Routine vendor digest/);

/**
 * Triage rows carry no per-row controls at all: the pile is the unit of work,
 * so the sweep on the heading is the affordance and the row is just the mail.
 */
assert.doesNotMatch(triageHtml, /mail-list-actions/, "a triage row is not a toolbar");
assert.doesNotMatch(
  triageHtml,
  /aria-label="Delete /,
  "no per-row delete control in triage",
);

// Nor is the list a form: no checkbox and no select-all bar until the user has
// actually started selecting.
assert.doesNotMatch(triageHtml, /mail-list-checkbox/, "checkboxes appear only when selecting");
assert.doesNotMatch(triageHtml, /mail-bulk-toolbar/);

/**
 * The sweep is offered on the two piles that can be emptied in one move, and
 * withheld from Atlas, whose rows have already left this queue.
 */
assert.match(triageHtml, /class="mail-list-sweep[^"]*"[^>]*>Clear \d+</, "the clear pile sweeps");
assert.match(triageHtml, /class="mail-list-sweep[^"]*"[^>]*>File \d+</, "the record pile files");
const sweepLabels = [...triageHtml.matchAll(/class="mail-list-sweep[^"]*"[^>]*>([^<]*)</g)].map(
  (m) => m[1],
);
assert.equal(sweepLabels.length, 2, `only two piles sweep, got ${sweepLabels.join(", ")}`);

const mixedHtml = renderToString(
  createElement(FolderList, {
    view: v3TriageInboxView,
    refreshing: false,
    sort: "triage",
    onSortChange: () => {},
    onOpen: () => {},
    onPrefetch: () => {},
    onCommands: noop,
    // One row Seer cleared for deletion, one it did not.
    initialSelectedIds: ["preview-c-delete", "preview-c-record"],
  }),
);
assert.match(
  mixedHtml,
  /data-state="some"/,
  "select-all must reach the indeterminate state for a partial selection",
);
assert.match(mixedHtml, /2(?:<!-- -->)? selected/);
/**
 * Delete acts on everything the user picked. A mixed selection — one Seer
 * cleared, one it refused — deletes both, because the person selected both.
 * Seer's reading constrains Seer's own sweeps, not its user.
 */
assert.match(mixedHtml, /Delete</, "Delete is offered for the whole selection");
assert.doesNotMatch(
  mixedHtml,
  /Delete(?:<!-- -->)* \(\d+\)/,
  "Delete no longer reports a reduced count",
);
assert.doesNotMatch(
  mixedHtml,
  /cleared for deletion/,
  "no refusal notice: the user's selection is the authority",
);


console.log("v3-inbox-triage-ui: OK");

/**
 * Triage is its own place.
 *
 * It was a sort on the inbox, and a sort is a thing you have to know to look
 * for. Now the inbox is your mail in the order it came and triage is the pile
 * Seer sorted, each with a tab, so neither hides inside the other.
 */
const clientSource = await fs.readFile("src/components/v3/MailClient.tsx", "utf8");
assert.match(clientSource, /const triaging = section === "triage"/,
  "triage is a section, not a sort on the inbox");
assert.match(clientSource, /mailboxSort: MailboxSort = triaging \? "triage" : "date"/,
  "the section decides the ordering");
assert.doesNotMatch(clientSource, /setInboxSort/, "there is no inbox sort state left");
assert.doesNotMatch(clientSource, /onSortChange/, "and no sort control to wire");
