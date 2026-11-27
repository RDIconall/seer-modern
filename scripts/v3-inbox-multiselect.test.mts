/**
 * Gate: the Inbox can be worked several matters at a time.
 *
 * Every group carries a tick box and a shift range runs in the order the groups
 * are READ, with the apply bar drawn only once something is ticked. Ticking is
 * a plan, not an action: the confirmation owns the moment where things run.
 */
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { InboxList } from "../src/components/v3/InboxList.tsx";
import { nextStepFor } from "../src/lib/v3/mailbox/next-step.ts";
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
  matterId: null,
  nextStep: nextStepFor({
    disposition: over.disposition ?? "matter",
    matterId: null,
    ask: null,
    summary: null,
    userStep: null,
  }),
  groupKey: `c:${over.conversationId ?? "c"}`,
  groupAt: "2026-08-17T09:00:00.000Z",
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
  sort: "matter",
  rows,
  total: rows.length,
  needsYou: 1,
  nextCursor: null,
};

const html = renderToString(
  createElement(InboxList, {
    view,
    onOpen() {},
    onPrefetch() {},
    onCommands: async () => [],
  } as never),
).replace(/<!--[\s\S]*?-->/g, "");

// Every group carries a tick box.
const rowBoxes = [...html.matchAll(/aria-label="Select (?!all)[^"]*"/g)];
assert.equal(rowBoxes.length, rows.length, "every group can be ticked");

// The apply bar is not drawn until something is ticked.
assert.doesNotMatch(html, /Do these next steps/);
assert.doesNotMatch(html, /Is this the next step/);
assert.match(html, /Check the steps you agree with/);

const ticked = renderToString(
  createElement(InboxList, {
    view,
    onOpen() {},
    onPrefetch() {},
    onCommands: async () => [],
    initialSelectedKeys: ["c:d1", "c:d2"],
  } as never),
).replace(/<!--[\s\S]*?-->/g, "");
assert.match(ticked, /2 selected/);
assert.match(ticked, /Do these next steps/);
assert.doesNotMatch(ticked, /Is this the next step/, "ticking asks nothing until you apply");

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

const source = await fs.readFile("src/components/v3/InboxList.tsx", "utf8");
assert.match(source, /reduceSelection/, "the Inbox uses the tested reducer");
assert.match(source, /kind: "row"/);
assert.match(source, /kind: "prune"/);
assert.match(source, /kind: "all"/);
assert.match(source, /Escape/, "Escape drops the selection");

const css = await fs.readFile("src/app/globals.css", "utf8");
assert.match(css, /\.inbox-apply\b/, "the apply button is styled");
assert.match(css, /\.bulk-confirm\b/, "the confirmation is styled");

console.log("v3-inbox-multiselect: OK");
