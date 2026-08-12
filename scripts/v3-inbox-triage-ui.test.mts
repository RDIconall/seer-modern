/**
 * Inbox triage sort: group headings, token-gated delete, and select-all
 * indeterminate state — all rendered from server-shaped mailbox rows.
 */
import assert from "node:assert/strict";
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
assert.doesNotMatch(dateHtml, /Safe to delete/);
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

assert.match(triageHtml, /Safe to delete/);
assert.match(triageHtml, /Filed for the record/);
assert.match(triageHtml, /Live matters/);
assert.match(triageHtml, /Not read yet/);
assert.match(triageHtml, /Seer cleared these for deletion/);
assert.match(triageHtml, /IT &amp; software notices|IT & software notices/);
assert.match(triageHtml, /Routine vendor digest/);

// A row without a delete token must not expose a per-row Delete control.
assert.match(triageHtml, /aria-label="Delete Your Monthly Scribe Activity"/);
assert.doesNotMatch(
  triageHtml,
  /aria-label="Delete Invoice received/,
  "record rows must not render a delete affordance without a token",
);
assert.doesNotMatch(
  triageHtml,
  /aria-label="Delete RMS Amendment/,
  "matter rows must not render a delete affordance without a token",
);

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
