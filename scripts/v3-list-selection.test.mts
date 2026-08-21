/**
 * Mailbox list selection rules, the ones a mail client is judged on: a shift
 * range that actually spans, an anchor that survives so ranges can be
 * re-drawn, and a selection that cannot outlive the rows it points at.
 */
import assert from "node:assert/strict";
import {
  EMPTY_SELECTION,
  reduceSelection,
  type Selection,
} from "../src/components/v3/list-selection.ts";

const ids = ["a", "b", "c", "d", "e"];
const run = (state: Selection, ...actions: Parameters<typeof reduceSelection>[1][]) =>
  actions.reduce((acc, action) => reduceSelection(acc, action, ids), state);

const sorted = (s: Selection) => [...s.ids].sort();

// A plain click ticks one row and drops an anchor there.
const one = run(EMPTY_SELECTION, { kind: "row", index: 0, shift: false });
assert.deepEqual(sorted(one), ["a"]);
assert.equal(one.anchor, 0);

// Clicking the same row again unticks it.
assert.deepEqual(
  sorted(run(one, { kind: "row", index: 0, shift: false })),
  [],
);

// THE REGRESSION: shift-click must span the range, not tick the far end alone.
const forward = run(one, { kind: "row", index: 3, shift: true });
assert.deepEqual(
  sorted(forward),
  ["a", "b", "c", "d"],
  "shift-click must select every row between the anchor and the click",
);

// The same range, drawn upwards.
const backward = run(
  EMPTY_SELECTION,
  { kind: "row", index: 3, shift: false },
  { kind: "row", index: 0, shift: true },
);
assert.deepEqual(sorted(backward), ["a", "b", "c", "d"]);

// The anchor stays put, so a second shift-click re-ranges from the origin
// instead of chaining off the previous click.
assert.equal(forward.anchor, 0);
const extended = run(forward, { kind: "row", index: 1, shift: true });
assert.equal(extended.anchor, 0);
assert.deepEqual(
  sorted(extended),
  ["a", "b", "c", "d"],
  "re-ranging must not walk the anchor down the list",
);

// Shift with no anchor yet is just a click; it must not throw or select all.
assert.deepEqual(
  sorted(run(EMPTY_SELECTION, { kind: "row", index: 2, shift: true })),
  ["c"],
);

// An index that is not on screen changes nothing.
assert.deepEqual(
  run(one, { kind: "row", index: 99, shift: false }),
  one,
  "an out-of-range index must be ignored, not crash the list",
);

// Group and select-all.
const group = run(EMPTY_SELECTION, {
  kind: "group",
  ids: ["b", "c"],
  checked: true,
});
assert.deepEqual(sorted(group), ["b", "c"]);
assert.deepEqual(
  sorted(run(group, { kind: "group", ids: ["b", "c"], checked: false })),
  [],
);
// Taking one pile must leave the others exactly as they were: the whole point
// of a per-pile select-all is clearing the newsletters without disturbing the
// live work sitting in the pile below it.
{
  const deletePile = ["a", "b"];
  const keepPile = ["d", "e"];
  const both = run(
    EMPTY_SELECTION,
    { kind: "group", ids: keepPile, checked: true },
    { kind: "group", ids: deletePile, checked: true },
  );
  assert.deepEqual(sorted(both), ["a", "b", "d", "e"]);
  assert.deepEqual(
    sorted(run(both, { kind: "group", ids: deletePile, checked: false })),
    keepPile,
    "clearing one pile must not clear another",
  );
}

assert.deepEqual(sorted(run(EMPTY_SELECTION, { kind: "all", checked: true })), ids);
assert.deepEqual(
  sorted(run(run(EMPTY_SELECTION, { kind: "all", checked: true }), {
    kind: "all",
    checked: false,
  })),
  [],
);

// Clearing forgets the anchor, so the next shift-click cannot span a range
// from a row the user has since stopped thinking about.
assert.deepEqual(run(forward, { kind: "clear" }), EMPTY_SELECTION);

// A tick on a row that has since left the list must not survive to act on
// something else later.
const pruned = reduceSelection(
  { ids: new Set(["a", "zzz"]), anchor: 0 },
  { kind: "prune" },
  ids,
);
assert.deepEqual([...pruned.ids], ["a"]);
assert.deepEqual(
  reduceSelection({ ids: new Set(["a"]), anchor: 0 }, { kind: "prune" }, ids).ids
    .size,
  1,
);
// Pruning an unchanged selection keeps the same object so React can bail out.
const stable: Selection = { ids: new Set(["a"]), anchor: 0 };
assert.equal(reduceSelection(stable, { kind: "prune" }, ids), stable);

console.log("v3-list-selection: OK");
