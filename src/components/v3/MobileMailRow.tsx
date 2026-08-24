"use client";

import * as React from "react";
import { useEffect, useRef, useState } from "react";
import { Archive, LayoutGrid, Paperclip, Trash2 } from "lucide-react";

export type MobileMailRowModel = {
  id: string;
  from: string;
  subject: string;
  preview: string;
  when: string;
  isUnread?: boolean;
  attachmentCount?: number;
  threadCount?: number;
  badge?: string;
};

const SWIPE_THRESHOLD = 88;
const ATLAS_SWIPE_THRESHOLD = 176;
const DIRECTION_LOCK = 1.35;
const LONG_PRESS_MS = 520;
const LONG_PRESS_SLOP = 10;

export function mobileSwipeAction(
  offset: number,
  allowAtlas = false,
): "archive" | "delete" | "atlas" | null {
  if (allowAtlas && offset >= ATLAS_SWIPE_THRESHOLD) return "atlas";
  if (offset >= SWIPE_THRESHOLD) return "delete";
  if (offset <= -SWIPE_THRESHOLD) return "archive";
  return null;
}

/**
 * The one mobile mail row. Inbox, Triage and Atlas feed it different data but
 * the muscle memory never changes: left archives, right deletes, tap reads.
 */
export function MobileMailRow({
  model,
  current = false,
  onOpen,
  onArchive,
  onDelete,
  actions,
  onLongPress,
  onAtlas,
  selectable = false,
  selected = false,
  selecting = false,
  onToggleSelect,
}: {
  model: MobileMailRowModel;
  current?: boolean;
  onOpen: () => void;
  onArchive: () => void;
  onDelete: () => void;
  /** Where this row can go, named in words. A swipe is not discoverable. */
  actions?: { label: string; run: () => void }[];
  onLongPress?: () => void;
  /** Triage only: a deliberate far-right pull sends the row to Atlas. */
  onAtlas?: () => void;
  /** Show the tick box, so several rows can be placed in one go. */
  selectable?: boolean;
  selected?: boolean;
  /** Something is already ticked, so a tap on the row aims at the tick box. */
  selecting?: boolean;
  onToggleSelect?: (shift: boolean) => void;
}) {
  const [offset, setOffset] = useState(0);
  const [dragging, setDragging] = useState(false);
  const start = useRef<{ x: number; y: number } | null>(null);
  const horizontal = useRef<boolean | null>(null);
  const moved = useRef(false);
  const offsetRef = useRef(0);
  const longPressTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const longPressFired = useRef(false);
  // React derives a checkbox's change from the click, but the modifier does not
  // reliably survive that hand-off, and a shift that arrives false quietly
  // turns a range select into two ordinary ticks.
  const shiftHeld = useRef(false);

  const cancelLongPress = () => {
    if (longPressTimer.current) clearTimeout(longPressTimer.current);
    longPressTimer.current = null;
  };

  useEffect(() => cancelLongPress, []);

  const reset = () => {
    start.current = null;
    horizontal.current = null;
    setDragging(false);
    offsetRef.current = 0;
    setOffset(0);
  };

  return (
    <div
      className="mobile-mail-row"
      data-unread={model.isUnread ? "true" : "false"}
      data-current={current ? "true" : "false"}
      data-dragging={dragging ? "true" : "false"}
      data-selected={selected ? "true" : "false"}
      data-long-atlas={
        onAtlas && offset >= ATLAS_SWIPE_THRESHOLD ? "true" : undefined
      }
    >
      {/* The tick box sits outside the swipe track, so it stays put while the
          face slides under the thumb. */}
      {selectable && onToggleSelect ? (
        <input
          type="checkbox"
          className="mobile-mail-select mail-focus-ring"
          checked={selected}
          aria-label={`Select ${model.subject || model.from || "conversation"}`}
          onClick={(event) => {
            shiftHeld.current = event.shiftKey;
            event.stopPropagation();
          }}
          onChange={() => onToggleSelect(shiftHeld.current)}
        />
      ) : null}
      {/* The swipe track wraps only the row face. Left as a child of the row
          itself, the reveals are sized to the whole row and paint their red and
          green over the buttons underneath. */}
      <div className="mobile-mail-row-track">
      <div className="mobile-mail-reveal mobile-mail-reveal-delete">
        {onAtlas && offset >= ATLAS_SWIPE_THRESHOLD ? (
          <>
            <LayoutGrid aria-hidden />
            <span>Atlas</span>
          </>
        ) : (
          <>
            <Trash2 aria-hidden />
            <span>Delete</span>
          </>
        )}
      </div>
      <div className="mobile-mail-reveal mobile-mail-reveal-archive">
        <Archive aria-hidden />
        <span>Archive</span>
      </div>
      <button
        type="button"
        className="mobile-mail-row-button"
        style={{ transform: `translateX(${offset}px)` }}
        aria-pressed={selecting ? selected : undefined}
        onClick={(event) => {
          // Once something is ticked the row itself is a bigger tick box. A tap
          // that navigated away instead would throw the selection away, which
          // is what makes bulk clearing feel hostile on a phone.
          if (selecting && onToggleSelect) {
            moved.current = false;
            onToggleSelect(event.shiftKey);
            return;
          }
          if (!moved.current) onOpen();
          moved.current = false;
        }}
        onPointerDown={(event) => {
          if (event.button !== 0) return;
          // A swipe acts on one row. While several are ticked that is a
          // contradiction, so the gestures stand down until the selection ends.
          if (selecting) return;
          event.currentTarget.setPointerCapture(event.pointerId);
          start.current = { x: event.clientX, y: event.clientY };
          horizontal.current = null;
          moved.current = false;
          longPressFired.current = false;
          cancelLongPress();
          if (onLongPress) {
            longPressTimer.current = setTimeout(() => {
              longPressFired.current = true;
              // Suppress the click synthesized after pointer-up.
              moved.current = true;
              setDragging(false);
              onLongPress();
            }, LONG_PRESS_MS);
          }
          setDragging(true);
        }}
        onPointerMove={(event) => {
          if (!start.current) return;
          const dx = event.clientX - start.current.x;
          const dy = event.clientY - start.current.y;
          if (
            Math.max(Math.abs(dx), Math.abs(dy)) > LONG_PRESS_SLOP
          ) {
            cancelLongPress();
          }
          if (horizontal.current === null && Math.max(Math.abs(dx), Math.abs(dy)) > 8) {
            horizontal.current = Math.abs(dx) > Math.abs(dy) * DIRECTION_LOCK;
          }
          if (!horizontal.current) return;
          moved.current = true;
          const next = Math.max(-220, Math.min(220, dx));
          offsetRef.current = next;
          setOffset(next);
        }}
        onPointerUp={() => {
          cancelLongPress();
          if (longPressFired.current) {
            longPressFired.current = false;
            reset();
            return;
          }
          const kind = mobileSwipeAction(offsetRef.current, Boolean(onAtlas));
          const action =
            kind === "archive"
              ? onArchive
              : kind === "delete"
                ? onDelete
                : kind === "atlas"
                  ? onAtlas
                : null;
          reset();
          if (action) action();
        }}
        onPointerCancel={() => {
          cancelLongPress();
          reset();
        }}
      >
        <span className="mobile-mail-row-top">
          <strong>{model.from || "Unknown sender"}</strong>
          <time className="tabular">{model.when}</time>
        </span>
        <span className="mobile-mail-row-subject">
          {model.subject || "(no subject)"}
        </span>
        <span className="mobile-mail-row-preview">{model.preview}</span>
        <span className="mobile-mail-row-meta">
          {model.attachmentCount ? (
            <span
              className="mobile-mail-row-attachment"
              aria-label={`${model.attachmentCount} attachment${
                model.attachmentCount === 1 ? "" : "s"
              }`}
            >
              <Paperclip aria-hidden />
            </span>
          ) : null}
          {model.badge ? <span>{model.badge}</span> : null}
          {model.threadCount && model.threadCount > 1 ? (
            <span className="mobile-mail-row-count tabular">
              {model.threadCount}
            </span>
          ) : null}
        </span>
      </button>
      </div>
      {actions && actions.length > 0 ? (
        <div className="mobile-mail-row-actions" role="group" aria-label={`Place ${model.subject || "conversation"}`}>
          {actions.map((action) => (
            <button
              key={action.label}
              type="button"
              onClick={action.run}
            >
              {action.label}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
