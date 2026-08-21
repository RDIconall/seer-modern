"use client";

import * as React from "react";
import { useEffect, useMemo, useState } from "react";
import { Search, X } from "lucide-react";

export type PaletteAction = {
  id: string;
  label: string;
  hint?: string;
  run: () => void;
};

export function CommandPalette({
  open,
  actions,
  onClose,
}: {
  open: boolean;
  actions: PaletteAction[];
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  useEffect(() => {
    if (open) setQuery("");
  }, [open]);
  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return needle
      ? actions.filter((action) => action.label.toLowerCase().includes(needle))
      : actions;
  }, [actions, query]);

  if (!open) return null;
  return (
    <div className="mail-palette-backdrop" onMouseDown={onClose}>
      <section
        className="mail-palette"
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
        onMouseDown={(event) => event.stopPropagation()}
        onKeyDown={(event) => {
          if (event.key === "Escape") onClose();
        }}
      >
        <header>
          <Search aria-hidden />
          <input
            autoFocus
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Type a command"
            aria-label="Find a command"
          />
          <button type="button" aria-label="Close command palette" onClick={onClose}>
            <X aria-hidden />
          </button>
        </header>
        <ul>
          {visible.map((action) => (
            <li key={action.id}>
              <button
                type="button"
                onClick={() => {
                  action.run();
                  onClose();
                }}
              >
                <span>{action.label}</span>
                {action.hint ? <kbd>{action.hint}</kbd> : null}
              </button>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
