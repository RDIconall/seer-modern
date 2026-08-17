/**
 * Gate: bulk selection cannot destroy mail the safety layer refused.
 *
 * A Gmail-style toolbar acts on "everything ticked", and a real selection is
 * mixed: some rows the server authorised for deletion, most not. Delete must
 * act on the authorised rows ALONE — never deleting a vetoed conversation, and
 * never quietly archiving the rest as a side effect nobody asked for.
 */
import assert from "node:assert/strict";
import {
  commandsForSelection,
  deletableCount,
  groupState,
  pruneSelection,
  rangeSelect,
  setGroup,
  toggleOne,
} from "../src/components/v2/triage-select.ts";

const rows = [
  { conversationId: "a", deleteToken: "tok-a" },
  { conversationId: "b" },
  { conversationId: "c", deleteToken: "tok-c" },
  { conversationId: "d" },
];
const ids = rows.map((r) => r.conversationId);

// THE CASE: a mixed selection deletes only what was authorised.
{
  const selected = new Set(ids);
  const commands = commandsForSelection(rows, selected, "trash");
  assert.deepEqual(
    commands.map((c) => `${c.command.type}:${c.conversationId}`),
    ["delete:a", "delete:c"],
    "delete must touch only the rows the server cleared, and archive none",
  );
}

// Archiving acts on the whole selection.
{
  const commands = commandsForSelection(rows, new Set(["a", "b"]), "archive");
  assert.deepEqual(
    commands.map((c) => `${c.command.type}:${c.conversationId}`),
    ["archive:a", "archive:b"],
  );
}

// A selection of only vetoed rows produces no delete at all.
{
  assert.deepEqual(commandsForSelection(rows, new Set(["b", "d"]), "trash"), []);
  assert.equal(deletableCount(rows, new Set(["b", "d"])), 0);
}

// The count the toolbar shows matches what delete will do.
{
  const selected = new Set(["a", "b", "c"]);
  assert.equal(deletableCount(rows, selected), 2);
  assert.equal(commandsForSelection(rows, selected, "trash").length, 2);
}

// Unselected rows are never acted on.
{
  const commands = commandsForSelection(rows, new Set(["a"]), "archive");
  assert.deepEqual(commands.map((c) => c.conversationId), ["a"]);
}

// --- Selection mechanics -------------------------------------------------

// Shift-click selects an inclusive range, in either direction.
{
  assert.deepEqual([...rangeSelect(new Set(), ids, 0, 2)], ["a", "b", "c"]);
  assert.deepEqual([...rangeSelect(new Set(), ids, 2, 0)], ["a", "b", "c"]);
  assert.deepEqual([...rangeSelect(new Set(), ids, 1, 1)], ["b"]);
}

// A range adds to what is already ticked rather than replacing it.
{
  assert.deepEqual([...rangeSelect(new Set(["d"]), ids, 0, 1)].sort(), [
    "a",
    "b",
    "d",
  ]);
}

// Toggling one row.
{
  assert.deepEqual([...toggleOne(new Set(), "a")], ["a"]);
  assert.deepEqual([...toggleOne(new Set(["a"]), "a")], []);
}

// Group checkbox selects and clears a whole section.
{
  assert.deepEqual([...setGroup(new Set(), ["a", "b"], true)], ["a", "b"]);
  assert.deepEqual([...setGroup(new Set(["a", "b", "c"]), ["a", "b"], false)], [
    "c",
  ]);
}

// The header checkbox reports all / some / none.
{
  assert.equal(groupState(new Set(), ids), "none");
  assert.equal(groupState(new Set(["a"]), ids), "some");
  assert.equal(groupState(new Set(ids), ids), "all");
  assert.equal(groupState(new Set(["a"]), []), "none");
}

// A tick on a row that has since been cleared must not survive to act on
// something else after the list changes underneath it.
{
  const stale = new Set(["a", "gone"]);
  assert.deepEqual([...pruneSelection(stale, ids)], ["a"]);
  assert.deepEqual(
    commandsForSelection(rows, pruneSelection(stale, ids), "archive").map(
      (c) => c.conversationId,
    ),
    ["a"],
  );
}

console.log("v2-triage-select: ok");
