import type { Command } from "@/lib/v2/commands/types";
import { commandFor, userCommandFor, type TriageActionRow } from "./triage-command";

/**
 * Bulk selection for triage, in the Gmail sense: visible checkboxes, a range
 * select, and one toolbar that acts on whatever is ticked.
 *
 * The selection logic lives here rather than in the component because the
 * dangerous part of "act on everything ticked" is deciding what Delete may
 * touch, and that deserves to be tested directly.
 */

/** Extend a selection with a shift-click range, Gmail style. */
export function rangeSelect(
  selected: Set<string>,
  ids: string[],
  anchorIndex: number,
  index: number,
): Set<string> {
  const next = new Set(selected);
  const [from, to] =
    anchorIndex <= index ? [anchorIndex, index] : [index, anchorIndex];
  for (let i = from; i <= to; i++) {
    const id = ids[i];
    if (id) next.add(id);
  }
  return next;
}

/** Toggle one row. */
export function toggleOne(selected: Set<string>, id: string): Set<string> {
  const next = new Set(selected);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  return next;
}

/** Add or remove a whole group (a section header checkbox, or select-all). */
export function setGroup(
  selected: Set<string>,
  ids: string[],
  checked: boolean,
): Set<string> {
  const next = new Set(selected);
  for (const id of ids) {
    if (checked) next.add(id);
    else next.delete(id);
  }
  return next;
}

/** A group's checkbox state: all, some (indeterminate), or none. */
export function groupState(
  selected: Set<string>,
  ids: string[],
): "all" | "some" | "none" {
  if (ids.length === 0) return "none";
  let picked = 0;
  for (const id of ids) if (selected.has(id)) picked++;
  if (picked === 0) return "none";
  return picked === ids.length ? "all" : "some";
}

/** Drop ids that are no longer on screen, so a stale tick cannot act later. */
export function pruneSelection(
  selected: Set<string>,
  visible: string[],
): Set<string> {
  const onScreen = new Set(visible);
  const next = new Set<string>();
  for (const id of selected) if (onScreen.has(id)) next.add(id);
  return next;
}

/**
 * The commands a toolbar action produces.
 *
 * Delete is the reason this is a tested function. A selection is what the user
 * picked out by hand, so Delete acts on all of it — Seer's reading of a
 * conversation does not get a veto over its reader. The token still governs the
 * pile-level sweep, where nobody looked at the rows one by one.
 */
export function commandsForSelection<T extends TriageActionRow>(
  rows: T[],
  selected: Set<string>,
  mode: "archive" | "trash",
): { command: Command; conversationId: string }[] {
  return rows
    .filter((r) => selected.has(r.conversationId))
    .map((row) => ({
      command: userCommandFor(row, mode),
      conversationId: row.conversationId,
    }));
}

/**
 * The commands a one-press sweep of a whole pile produces. This is Seer acting
 * over mail the user has not read row by row, so it may only delete what the
 * server cleared and archives the rest.
 */
export function sweepCommands<T extends TriageActionRow>(
  rows: T[],
  ids: Set<string>,
  mode: "archive" | "trash",
): { command: Command; conversationId: string }[] {
  return rows
    .filter((r) => ids.has(r.conversationId))
    .map((row) => ({
      command: commandFor(row, mode),
      conversationId: row.conversationId,
    }));
}

/** How many of the selected rows Delete would actually act on. */
export function deletableCount<T extends TriageActionRow>(
  rows: T[],
  selected: Set<string>,
): number {
  return rows.filter((r) => selected.has(r.conversationId) && r.deleteToken)
    .length;
}
