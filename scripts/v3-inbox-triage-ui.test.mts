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

assert.match(dateHtml, /Date/);
assert.match(dateHtml, /Most likely to delete/);
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

// The ledger counts what still needs the user across the whole inbox, from the
// server's count, not from the rows that happen to have loaded.
assert.match(triageHtml, /mail-list-ledger/);
const triageText = triageHtml.replace(/<!--[\s\S]*?-->/g, "");
assert.match(
  triageText,
  new RegExp(`${v3TriageInboxView.needsYou} need you`),
  "the ledger reports the server needsYou count",
);

assert.match(triageHtml, /Ready to clear/);
assert.match(triageHtml, /Filed for the record/);
assert.match(triageHtml, /Needs you/);
assert.match(triageHtml, /Live matters/);
assert.match(triageHtml, /Not read yet/);

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
const needsYouAt = triageHtml.indexOf("Needs you");
assert.ok(heldAt > -1 && needsYouAt > -1 && heldAt < needsYouAt,
  "the note sits under the clear pile, above Needs you");
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
 * withheld from the ones that cannot: a live matter is not cleared in bulk, and
 * "Needs you" is the pile whose whole point is that each one wants a look.
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
assert.match(
  mixedHtml,
  /Delete(?:<!-- -->)* \(1\)/,
  "Delete must count only the rows it is authorised to act on",
);
assert.match(
  mixedHtml,
  /aren’t cleared for deletion/,
  "a mixed selection must say how much of it Delete will skip",
);

console.log("v3-inbox-triage-ui: OK");

/**
 * The inbox opens triaged.
 *
 * Everything above — the piles, the ledger, the held-back note, the row that
 * says what a message means rather than quoting its first line — hangs off this
 * sort. Shipped behind a toggle nobody flips, it may as well not exist, and for
 * a while it did not: the inbox looked exactly as it always had.
 */
const clientSource = await fs.readFile("src/components/v3/MailClient.tsx", "utf8");
assert.match(
  clientSource,
  /useState<MailboxSort>\(\s*preview\?\.mailbox\.inbox\.sort \?\? "triage"/,
  "the inbox must open sorted by what to do with the mail",
);
// Whichever sort is the default is the one the hash leaves out, so the other
// one survives a reload.
assert.match(
  clientSource,
  /if \(sort !== "triage"\) params\.set\("sort", sort\)/,
  "date has to be written to the hash now that triage is the default",
);
