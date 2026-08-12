import {
  pruneSelection,
  rangeSelect,
  setGroup,
  toggleOne,
} from "@/components/v2/triage-select";

/**
 * Mailbox list selection, as a reducer rather than a handful of handlers.
 *
 * This lives outside the component because the interesting part is not which
 * checkbox was clicked but what a click MEANS next to the one before it — a
 * shift range needs an anchor that survives re-renders, and an anchor that is
 * quietly overwritten turns a range select back into two single ticks. That is
 * exactly the bug this replaces, and it was invisible because the rule had
 * nowhere to be tested.
 */

export type Selection = {
  ids: ReadonlySet<string>;
  /** Index of the last plain click — where a shift range starts from. */
  anchor: number | null;
};

export const EMPTY_SELECTION: Selection = { ids: new Set<string>(), anchor: null };

export type SelectionAction =
  | { kind: "row"; index: number; shift: boolean }
  | { kind: "group"; ids: string[]; checked: boolean }
  | { kind: "all"; checked: boolean }
  | { kind: "clear" }
  | { kind: "prune" };

export function reduceSelection(
  state: Selection,
  action: SelectionAction,
  allIds: string[],
): Selection {
  switch (action.kind) {
    case "row": {
      const id = allIds[action.index];
      if (id === undefined) return state;
      // A shift range extends from the anchor and LEAVES it in place, so
      // repeated shift-clicks re-range from the same origin the way Gmail's do
      // rather than walking the anchor down the list one click at a time.
      if (action.shift && state.anchor !== null) {
        return {
          ids: rangeSelect(
            new Set(state.ids),
            allIds,
            state.anchor,
            action.index,
          ),
          anchor: state.anchor,
        };
      }
      return { ids: toggleOne(new Set(state.ids), id), anchor: action.index };
    }
    case "group":
      return {
        ids: setGroup(new Set(state.ids), action.ids, action.checked),
        anchor: state.anchor,
      };
    case "all":
      return {
        ids: setGroup(new Set(state.ids), allIds, action.checked),
        anchor: action.checked ? state.anchor : null,
      };
    case "clear":
      return EMPTY_SELECTION;
    case "prune": {
      const ids = pruneSelection(new Set(state.ids), allIds);
      if (ids.size === state.ids.size) return state;
      return { ids, anchor: ids.size === 0 ? null : state.anchor };
    }
  }
}
