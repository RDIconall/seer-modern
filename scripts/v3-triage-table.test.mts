import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { TriageTable } from "../src/components/v3/TriageTable.tsx";
import { v3Preview } from "../src/app/dev/preview/v3-sample.ts";

const view = v3Preview.triageInbox!;
const html = renderToString(
  createElement(TriageTable, {
    view,
    onCommands: async () => [],
    onOpen: () => {},
    onPiles: () => {},
  }),
);

for (const heading of ["From", "Subject", "When", "Actions"]) {
  assert.match(html, new RegExp(`>${heading}<`));
}
assert.match(html, /Seer(?:'|&#x27;)s read/);
assert.match(html, /triage-table/);
assert.match(html, /Table/);
assert.match(html, /Piles/);
assert.match(html, /Archive/);
assert.match(html, /Delete/);
assert.match(html, /Keep/);
assert.match(html, /Cards/);
assert.match(html, /type="checkbox"/);

console.log("v3-triage-table: OK");
