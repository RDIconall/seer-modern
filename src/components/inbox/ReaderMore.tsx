"use client";

import { useEffect, useRef, useState } from "react";
import type { TriageAction } from "@/lib/inbox/classify";
import type { Guide } from "@/lib/inbox/types";
import { TEACH_CHOICES, teachGroup } from "@/components/inbox/LogicExplain";
import {
  BellOff,
  CalendarClock,
  MoreHorizontal,
  Sparkles,
  UserCheck,
} from "lucide-react";

/**
 * Everything the reader can do that isn't reply, archive, or delete.
 *
 * These used to be three competing rows above the message — a teach strip
 * that repeated Archive and Delete from the toolbar, and a chip row of
 * canned replies. One menu, opened on demand, gives the message back its
 * space and leaves exactly one place to look for a secondary action.
 */
export function ReaderMore({
  guide,
  drafting,
  onDraft,
  onDelegate,
  onSchedule,
  onUnsubscribe,
  onTeach,
  light,
}: {
  guide?: Guide;
  drafting?: boolean;
  onDraft?: () => void;
  onDelegate?: () => void;
  onSchedule?: () => void;
  onUnsubscribe?: () => void;
  onTeach?: (action: TriageAction) => void;
  /** Rendered on a colored header (mobile), so the trigger is white. */
  light?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!wrap.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const current = guide ? teachGroup(guide.action) : null;
  const corrections = onTeach
    ? TEACH_CHOICES.filter((c) => c.action !== current)
    : [];
  const run = (fn?: () => void) => () => {
    setOpen(false);
    fn?.();
  };

  return (
    <div ref={wrap} className="relative shrink-0">
      <button
        type="button"
        aria-label="More actions"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className={`flex h-9 w-9 items-center justify-center rounded-md ${
          light
            ? "text-white hover:bg-white/15"
            : "text-[var(--fg)] hover:bg-[var(--row-hover)]"
        }`}
      >
        <MoreHorizontal className="h-5 w-5" />
      </button>

      {open ? (
        <div
          role="menu"
          className="reader-menu absolute right-0 top-full z-50 mt-1 w-60 overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--bg)] py-1 shadow-lg"
        >
          {onDraft ? (
            <MenuItem
              icon={<Sparkles className="h-4 w-4" />}
              label={drafting ? "Drafting…" : "Draft a reply"}
              disabled={drafting}
              onClick={run(onDraft)}
            />
          ) : null}
          {onDelegate ? (
            <MenuItem
              icon={<UserCheck className="h-4 w-4" />}
              label="Delegate…"
              onClick={run(onDelegate)}
            />
          ) : null}
          {onSchedule ? (
            <MenuItem
              icon={<CalendarClock className="h-4 w-4" />}
              label="Block time for this"
              onClick={run(onSchedule)}
            />
          ) : null}
          {onUnsubscribe ? (
            <MenuItem
              icon={<BellOff className="h-4 w-4" />}
              label="Unsubscribe"
              onClick={run(onUnsubscribe)}
            />
          ) : null}

          {corrections.length > 0 ? (
            <>
              <div className="mt-1 border-t border-[var(--border)] px-3 pb-1 pt-2 text-[12px] text-[var(--muted)]">
                Wrong call — this is
              </div>
              {corrections.map((c) => (
                <MenuItem
                  key={c.action}
                  label={c.label}
                  onClick={run(() => onTeach?.(c.action))}
                />
              ))}
            </>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function MenuItem({
  icon,
  label,
  onClick,
  disabled,
}: {
  icon?: React.ReactNode;
  label: string;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      disabled={disabled}
      onClick={onClick}
      className="flex w-full items-center gap-2.5 px-3 py-2.5 text-left text-[14px] text-[var(--fg)] hover:bg-[var(--row-hover)] disabled:opacity-40"
    >
      {icon ? (
        <span className="shrink-0 text-[var(--muted)]">{icon}</span>
      ) : (
        <span className="w-4 shrink-0" />
      )}
      <span className="min-w-0 flex-1">{label}</span>
    </button>
  );
}
