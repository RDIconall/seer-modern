"use client";

import * as React from "react";
import { useRef } from "react";

/**
 * A checkbox that can show the third, "some of this group" state.
 *
 * The shift key is read from the CLICK, not from the change event's native
 * event. React derives a checkbox's change from the click, but the modifier
 * does not reliably survive that hand-off, and a shift that arrives as `false`
 * silently degrades a range select into two ordinary ticks.
 */
export function Check({
  state,
  onChange,
  label,
}: {
  state: "all" | "some" | "none";
  onChange: (checked: boolean, shift: boolean) => void;
  label: string;
}) {
  const shift = useRef(false);
  return (
    <input
      type="checkbox"
      aria-label={label}
      data-state={state}
      checked={state === "all"}
      ref={(el) => {
        // The browser maps `indeterminate` to aria-checked="mixed" itself;
        // setting that attribute here as well would conflict with the native
        // checked state a screen reader already reads.
        if (el) el.indeterminate = state === "some";
      }}
      onClick={(e) => {
        shift.current = e.shiftKey;
        e.stopPropagation();
      }}
      onChange={(e) => onChange(e.target.checked, shift.current)}
      className="mail-list-checkbox mail-focus-ring"
    />
  );
}
