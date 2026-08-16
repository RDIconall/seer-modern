"use client";

import { useRef, useState } from "react";
import { Archive, CornerUpLeft, Forward, Trash2 } from "lucide-react";

/**
 * CONVERSATION ROW — a matter's email, with the four things you actually do
 * to it: reply, forward, archive, delete.
 *
 * No chrome is added for them. On a pointer device the cluster is invisible
 * until the row is hovered or keyboard-focused, so the panel reads exactly
 * as it did before. On touch there is no hover, so the same four live behind
 * a swipe: left past the threshold archives, left past the far threshold
 * deletes, right replies. Every action is also a keystroke (see MatterPanel),
 * which is the only affordance a desktop power user actually wants.
 */

export type RowAction = "reply" | "forward" | "archive" | "trash";

const NEAR = 76; // archive / reply
const FAR = 168; // delete

export function ConversationRow({
  from,
  meaning,
  when,
  count,
  cursor,
  mobile,
  onOpen,
  onAction,
}: {
  from: string;
  meaning: string;
  when: string;
  count?: number;
  /** Keyboard cursor is on this row — shows the same affordance as hover. */
  cursor?: boolean;
  mobile?: boolean;
  onOpen: () => void;
  onAction: (action: RowAction) => void;
}) {
  const [dx, setDx] = useState(0);
  const [sliding, setSliding] = useState(false);
  const start = useRef(0);
  const active = useRef(false);

  // --- touch: the four actions without a visible toolbar ---
  function down(e: React.PointerEvent) {
    if (!mobile) return;
    if ((e.target as HTMLElement).closest("button[data-action]")) return;
    start.current = e.clientX;
    active.current = true;
    setSliding(false);
  }
  function move(e: React.PointerEvent) {
    if (!active.current) return;
    const next = e.clientX - start.current;
    if (Math.abs(next) > 6) {
      e.currentTarget.setPointerCapture?.(e.pointerId);
      setSliding(true);
    }
    setDx(next);
  }
  function up() {
    if (!active.current) return;
    active.current = false;
    const travelled = dx;
    setSliding(false);
    setDx(0);
    if (travelled <= -FAR) onAction("trash");
    else if (travelled <= -NEAR) onAction("archive");
    else if (travelled >= NEAR) onAction("reply");
  }

  const intent =
    dx <= -FAR ? "Delete" : dx <= -NEAR ? "Archive" : dx >= NEAR ? "Reply" : "";

  return (
    <li className="relative overflow-hidden border-b border-[var(--border)]">
      {/* What the swipe is about to do. Only ever visible mid-gesture. */}
      {mobile && dx !== 0 ? (
        <div
          className={`pointer-events-none absolute inset-0 flex items-center px-4 text-[12px] ${
            dx < 0 ? "justify-end" : "justify-start"
          } ${dx <= -FAR ? "bg-[var(--danger,#B44A24)] text-white" : "bg-[var(--row-hover)] text-[var(--muted)]"}`}
        >
          {intent}
        </div>
      ) : null}

      <div
        onPointerDown={down}
        onPointerMove={move}
        onPointerUp={up}
        onPointerCancel={up}
        style={{
          transform: dx ? `translateX(${dx}px)` : undefined,
          transition: sliding ? "none" : "transform .18s ease",
        }}
        className={`group relative flex items-start gap-1 bg-[var(--bg)] ${
          cursor ? "bg-[var(--row-hover)]" : ""
        }`}
      >
        <button
          type="button"
          onClick={onOpen}
          className="min-w-0 flex-1 px-4 py-3 text-left"
        >
          <span className="flex items-baseline gap-2">
            <span className="min-w-0 flex-1 truncate text-[14px] font-bold text-[var(--fg-strong)]">
              {from}
            </span>
            {count && count > 1 ? (
              <span className="shrink-0 text-[12px] text-[var(--nav-muted)]">
                {count}
              </span>
            ) : null}
            {when ? (
              <span className="shrink-0 text-[12px] text-[var(--nav-muted)]">
                {when}
              </span>
            ) : null}
          </span>
          <span className="mt-0.5 line-clamp-2 block text-[14px] leading-5 text-[var(--muted)]">
            {meaning}
          </span>
        </button>

        {/* Desktop: nothing until you hover the row or tab into it. */}
        {!mobile ? (
          <span
            className={`mr-1 mt-1.5 flex shrink-0 items-center transition-opacity ${
              cursor
                ? "opacity-100"
                : "opacity-0 focus-within:opacity-100 group-hover:opacity-100"
            }`}
          >
            <RowButton label="Reply" hint="r" onClick={() => onAction("reply")}>
              <CornerUpLeft className="h-4 w-4" />
            </RowButton>
            <RowButton label="Forward" hint="f" onClick={() => onAction("forward")}>
              <Forward className="h-4 w-4" />
            </RowButton>
            <RowButton label="Archive" hint="e" onClick={() => onAction("archive")}>
              <Archive className="h-4 w-4" />
            </RowButton>
            <RowButton label="Delete" hint="#" onClick={() => onAction("trash")}>
              <Trash2 className="h-4 w-4" />
            </RowButton>
          </span>
        ) : null}
      </div>
    </li>
  );
}

function RowButton({
  label,
  hint,
  onClick,
  children,
}: {
  label: string;
  hint: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      data-action
      onClick={onClick}
      aria-label={label}
      title={`${label} (${hint})`}
      className="flex h-9 w-9 items-center justify-center rounded-full text-[var(--nav-muted)] hover:bg-[var(--row-hover)] hover:text-[var(--fg)]"
    >
      {children}
    </button>
  );
}
