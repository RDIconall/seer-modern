"use client";

import * as React from "react";
import {
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from "react";
import type { Command } from "@/lib/v2/commands/types";
import type { MailboxRow } from "@/lib/v3/mailbox/types";
import {
  EMPTY_SELECTION,
  reduceSelection,
  type Selection,
  type SelectionAction,
} from "./list-selection";
import {
  dayLabel,
  timeLabel,
  triagePiles,
  VERB_HINT,
  type TriageVerb,
} from "@/lib/v3/mailbox/triage-verb";

/**
 * Triage.
 *
 * Four piles named after what you are about to do — delete it, file it, answer
 * it, keep it — with the mail's own days inside each. Seer does the grouping;
 * the dates belong to the mail, and neither is annotated at the other's expense.
 *
 * Every row leaves in one of four directions and only one ends on the board:
 * anything not deleted and not filed is live work, so Keep makes it a matter on
 * Atlas. That is the whole claim of the screen — triage is the mouth of Atlas,
 * not a bin with a bin next to it.
 */

/** Right past this files; a longer left pull deletes. */
const NEAR = 78;
const FAR = 176;

type Settled = { row: MailboxRow; what: string };

type TriageAction = "atlas" | "archive" | "delete";

const commandFor = (row: MailboxRow, action: TriageAction): Command =>
  action === "atlas"
    ? {
        type: "correctConversation",
        conversationId: row.conversationId,
        home: "matter",
        note: "kept in triage",
      }
    : action === "archive"
      ? { type: "archive", conversationId: row.conversationId }
      : {
          type: "delete",
          conversationId: row.conversationId,
          byUser: true,
        };

const settledLabel = (action: TriageAction): string =>
  action === "atlas" ? "Atlas" : action === "archive" ? "Archived" : "Deleted";

function tableDate(timestamp: string): string {
  const day = dayLabel(timestamp);
  const time = timeLabel(timestamp);
  return time || day;
}

export function TriageList({
  rows,
  onCommands,
  onOpen,
}: {
  rows: MailboxRow[];
  onCommands: (commands: Command[]) => Promise<unknown>;
  onOpen: (row: MailboxRow) => void;
}) {
  const [settled, setSettled] = useState<Settled[]>([]);
  const settledIds = useMemo(
    () => new Set(settled.map((s) => s.row.conversationId)),
    [settled],
  );
  const piles = useMemo(() => triagePiles(rows, settledIds), [rows, settledIds]);
  const orderedRows = useMemo(
    () => piles.flatMap((pile) => pile.days.flatMap((day) => day.rows)),
    [piles],
  );
  const allIds = useMemo(
    () => orderedRows.map((row) => row.conversationId),
    [orderedRows],
  );
  const indexById = useMemo(
    () => new Map(allIds.map((id, index) => [id, index])),
    [allIds],
  );
  const allIdsRef = useRef(allIds);
  allIdsRef.current = allIds;
  const [selection, dispatchSelection] = useReducer(
    (state: Selection, action: SelectionAction) =>
      reduceSelection(state, action, allIdsRef.current),
    EMPTY_SELECTION,
  );
  const [selectMode, setSelectMode] = useState(false);
  const [focusIndex, setFocusIndex] = useState(0);
  const sectionRef = useRef<HTMLElement>(null);

  useEffect(() => {
    dispatchSelection({ kind: "prune" });
    setFocusIndex((index) => Math.min(index, Math.max(0, allIds.length - 1)));
  }, [allIds]);

  const selected = selection.ids;
  const selectedRows = orderedRows.filter((row) =>
    selected.has(row.conversationId),
  );
  const selecting = selectMode || selected.size > 0;

  const settleRows = useCallback(
    (picked: MailboxRow[], action: TriageAction) => {
      if (picked.length === 0) return;
      const what = settledLabel(action);
      setSettled((prev) => [
        ...prev,
        ...picked.map((row) => ({ row, what })),
      ]);
      dispatchSelection({ kind: "clear" });
      setSelectMode(false);
      void onCommands(picked.map((row) => commandFor(row, action)));
    },
    [onCommands],
  );

  const act = useCallback(
    (row: MailboxRow, action: TriageAction) => settleRows([row], action),
    [settleRows],
  );

  const bulkAct = useCallback(
    (action: TriageAction) => {
      const current = orderedRows[focusIndex];
      settleRows(selectedRows.length > 0 ? selectedRows : current ? [current] : [], action);
    },
    [focusIndex, orderedRows, selectedRows, settleRows],
  );

  const focusRow = useCallback((index: number) => {
    const bounded = Math.max(0, Math.min(allIdsRef.current.length - 1, index));
    setFocusIndex(bounded);
    requestAnimationFrame(() => {
      sectionRef.current
        ?.querySelector<HTMLElement>(`[data-triage-index="${bounded}"]`)
        ?.focus();
    });
  }, []);

  const onKeyDown = (event: React.KeyboardEvent<HTMLElement>) => {
    const target = event.target as HTMLElement;
    const typing = target.matches("input:not([type=checkbox]), textarea, select");
    if (typing) return;

    if (event.key === "Escape") {
      dispatchSelection({ kind: "clear" });
      setSelectMode(false);
      return;
    }
    if (event.key === "ArrowDown" || event.key.toLowerCase() === "j") {
      event.preventDefault();
      focusRow(focusIndex + 1);
      return;
    }
    if (event.key === "ArrowUp" || event.key.toLowerCase() === "k") {
      event.preventDefault();
      focusRow(focusIndex - 1);
      return;
    }
    if (event.key.toLowerCase() === "x" || event.key === " ") {
      event.preventDefault();
      dispatchSelection({ kind: "row", index: focusIndex, shift: event.shiftKey });
      setSelectMode(true);
      return;
    }
    if (event.key === "Enter") {
      const row = orderedRows[focusIndex];
      if (row) onOpen(row);
      return;
    }
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    if (event.key.toLowerCase() === "a") {
      event.preventDefault();
      bulkAct("archive");
      return;
    }
    if (event.key.toLowerCase() === "m") {
      event.preventDefault();
      bulkAct("atlas");
      return;
    }
    if (event.key === "Delete" || event.key === "Backspace") {
      event.preventDefault();
      bulkAct("delete");
    }
  };

  const onRowClick = (
    event: React.MouseEvent,
    row: MailboxRow,
    index: number,
  ) => {
    setFocusIndex(index);
    if (event.shiftKey || event.metaKey || event.ctrlKey || selecting) {
      event.preventDefault();
      dispatchSelection({ kind: "row", index, shift: event.shiftKey });
      setSelectMode(true);
      return;
    }
    onOpen(row);
  };

  const undo = (row: MailboxRow) => {
    const entry = settled.find((s) => s.row.conversationId === row.conversationId);
    setSettled((prev) => prev.filter((s) => s.row.conversationId !== row.conversationId));
    if (!entry) return;
    // Deleting and filing both moved the mail, so putting it back is a restore.
    // Keeping it only changed Seer's mind, and there is nothing to fetch back.
    if (entry.what === "Deleted" || entry.what === "Archived") {
      void onCommands([{ type: "restore", conversationId: row.conversationId }]);
    }
  };

  const counted = (what: string) => settled.filter((s) => s.what === what).length;

  return (
    <section
      ref={sectionRef}
      className="tri"
      aria-label="Triage"
      data-selecting={selecting ? "true" : undefined}
      onKeyDown={onKeyDown}
    >
      {orderedRows.length > 0 && (
        <div className="tri-toolbar" role="toolbar" aria-label="Triage actions">
          <label className="tri-select-all">
            <input
              type="checkbox"
              checked={selected.size > 0 && selected.size === orderedRows.length}
              onChange={(event) => {
                dispatchSelection({ kind: "all", checked: event.target.checked });
                setSelectMode(event.target.checked);
              }}
            />
            <span>
              {selected.size > 0 ? `${selected.size} selected` : "Select all"}
            </span>
          </label>
          <div className="tri-bulk-actions">
            <button type="button" disabled={selected.size === 0} onClick={() => bulkAct("delete")}>
              Delete
            </button>
            <button type="button" disabled={selected.size === 0} onClick={() => bulkAct("archive")}>
              Archive
            </button>
            <button type="button" disabled={selected.size === 0} onClick={() => bulkAct("atlas")}>
              Atlas
            </button>
            <button
              type="button"
              className="tri-select-toggle"
              onClick={() => {
                if (selecting) dispatchSelection({ kind: "clear" });
                setSelectMode(!selecting);
              }}
            >
              {selecting ? "Done" : "Select"}
            </button>
          </div>
          <span className="tri-key-help">
            J/K move · X select · A archive · M Atlas · ⌫ delete
          </span>
        </div>
      )}
      {piles.length === 0 ? (
        <div className="tri-end">
          <b>Clear</b>
          {counted("Deleted")} deleted · {counted("Archived")} archived ·{" "}
          {counted("Answered")} answered · {counted("Atlas")} to Atlas
        </div>
      ) : (
        piles.map((pile) => (
          <div key={pile.verb} className="tri-pile" data-verb={pile.verb}>
            <h2 className="tri-g">
              <span>
                {pile.label}
                <em className="tabular">{pile.count}</em>
              </span>
              <small>{VERB_HINT[pile.verb]}</small>
            </h2>
            <div className="tri-table-head" aria-hidden>
              <span />
              <span>From</span>
              <span>Subject</span>
              <span>Why</span>
              <span>Category</span>
              <span>Date</span>
              <span>Actions</span>
            </div>
            {pile.days.map((day) => (
              <div key={day.day} className="tri-day-group">
                <div className="tri-day tabular">{day.day}</div>
                <div className="tri-set">
                  {day.rows.map((row) => {
                    const index = indexById.get(row.conversationId) ?? 0;
                    return (
                    <TriageRow
                      key={row.conversationId}
                      row={row}
                      verb={pile.verb}
                      index={index}
                      checked={selected.has(row.conversationId)}
                      selecting={selecting}
                      onClick={(event) => onRowClick(event, row, index)}
                      onCheck={(shift) => {
                        dispatchSelection({ kind: "row", index, shift });
                        setSelectMode(true);
                        setFocusIndex(index);
                      }}
                      onOpen={() => onOpen(row)}
                      onAtlas={() => act(row, "atlas")}
                      onFile={() => act(row, "archive")}
                      onTrash={() => act(row, "delete")}
                    />
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
        ))
      )}

      {settled.length > 0 && (
        <div className="tri-set tri-settled">
          {settled.map((entry) => (
            <div key={entry.row.conversationId} className="tri-was tabular">
              <span>
                {entry.what} · {entry.row.senderDisplayName || "Unknown sender"}
              </span>
              <button type="button" onClick={() => undo(entry.row)}>
                Undo
              </button>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

function TriageRow({
  row,
  verb,
  index,
  checked,
  selecting,
  onClick,
  onCheck,
  onOpen,
  onAtlas,
  onFile,
  onTrash,
}: {
  row: MailboxRow;
  verb: TriageVerb;
  index: number;
  checked: boolean;
  selecting: boolean;
  onClick: (event: React.MouseEvent<HTMLDivElement>) => void;
  onCheck: (shift: boolean) => void;
  onOpen: () => void;
  onAtlas: () => void;
  onFile: () => void;
  onTrash: () => void;
}) {
  const [dx, setDx] = useState(0);
  const [sliding, setSliding] = useState(false);
  const start = useRef<{ x: number; y: number } | null>(null);
  const horizontal = useRef<boolean | null>(null);
  const moved = useRef(false);
  const wheelTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const wheelDx = useRef(0);

  const far = dx <= -FAR;
  const time = timeLabel(row.timestamp);

  const onPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if ((event.target as HTMLElement).closest("button, input, label, textarea")) return;
    start.current = { x: event.clientX, y: event.clientY };
    horizontal.current = null;
    moved.current = false;
    setSliding(true);
  };
  const onPointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!start.current) return;
    const nextX = event.clientX - start.current.x;
    const nextY = event.clientY - start.current.y;
    if (horizontal.current === null) {
      if (Math.abs(nextX) < 10 && Math.abs(nextY) < 10) return;
      horizontal.current = Math.abs(nextX) > Math.abs(nextY) * 1.4;
    }
    if (!horizontal.current) return;
    moved.current = true;
    event.currentTarget.setPointerCapture?.(event.pointerId);
    setDx(nextX);
  };
  const end = () => {
    if (!start.current && !moved.current) return;
    const travelled = dx;
    start.current = null;
    horizontal.current = null;
    setSliding(false);
    setDx(0);
    if (travelled > NEAR) return onAtlas();
    if (travelled <= -FAR) return onTrash();
    if (travelled <= -NEAR) return onFile();
  };

  useEffect(
    () => () => {
      if (wheelTimer.current) clearTimeout(wheelTimer.current);
    },
    [],
  );

  /**
   * A two-finger horizontal trackpad gesture follows the same rail as touch:
   * right → Atlas, short left → Archive, long left → Delete. Wheel events
   * arrive as a burst, so settle once the burst stops.
   */
  const onWheel = (event: React.WheelEvent<HTMLDivElement>) => {
    if (selecting || Math.abs(event.deltaX) <= Math.abs(event.deltaY)) return;
    event.preventDefault();
    moved.current = true;
    wheelDx.current = Math.max(-240, Math.min(150, wheelDx.current - event.deltaX));
    setDx(wheelDx.current);
    setSliding(true);
    if (wheelTimer.current) clearTimeout(wheelTimer.current);
    wheelTimer.current = setTimeout(() => {
      const travelled = wheelDx.current;
      wheelDx.current = 0;
      setSliding(false);
      setDx(0);
      if (travelled > NEAR) onAtlas();
      else if (travelled <= -FAR) onTrash();
      else if (travelled <= -NEAR) onFile();
      window.setTimeout(() => {
        moved.current = false;
      }, 0);
    }, 140);
  };

  return (
    <div
      className="tri-r"
      data-far={far ? "true" : undefined}
      data-selected={checked ? "true" : undefined}
    >
      {/* What the pull will do, named before it commits. */}
      <div className="tri-rev tabular">
        <span className="tri-rev-keep">ATLAS</span>
        <span className="tri-rev-drop">{far ? "DELETE" : "ARCHIVE"}</span>
      </div>
      <div
        className="tri-in"
        role="row"
        tabIndex={index === 0 ? 0 : -1}
        data-triage-index={index}
        aria-selected={checked}
        style={{
          transform: `translateX(${dx}px)`,
          transition: sliding ? "none" : "transform .2s ease",
        }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={end}
        onPointerCancel={end}
        onWheel={onWheel}
        onClick={(event) => {
          if (moved.current) {
            event.preventDefault();
            event.stopPropagation();
            moved.current = false;
            return;
          }
          onClick(event);
        }}
      >
        <label className="tri-check" onClick={(event) => event.stopPropagation()}>
          <input
            type="checkbox"
            checked={checked}
            onChange={(event) => {
              const native = event.nativeEvent as MouseEvent;
              onCheck(Boolean(native.shiftKey));
            }}
            aria-label={`Select ${row.subject || "conversation"}`}
          />
        </label>
        <div className="tri-l1 tri-cell-from">
          {row.isUnread && <span className="tri-dot" aria-hidden />}
          <span className={`tri-from${row.isUnread ? "" : " tri-read"}`}>
            {row.senderDisplayName || "Unknown sender"}
          </span>
          <span className="tri-mobile-when tabular">{time || "—"}</span>
        </div>
        <div className={`tri-subj tri-cell-subject${row.isUnread ? "" : " tri-read"}`}>
          {row.subject || "(no subject)"}
        </div>
        <div className="tri-snip tri-cell-why">
          {row.decisionSummary || row.snippet || ""}
        </div>
        <div className="tri-cell-category tabular">
          {row.category || (verb === "answer" ? "Reply" : "—")}
        </div>
        <time className="tri-when tri-cell-date tabular" dateTime={row.timestamp}>
          {tableDate(row.timestamp) || "—"}
        </time>
        {(row.attachments.length > 0 || verb === "answer") && (
          <div className="tri-clip tabular">
            {row.attachments.length > 0
              ? `${row.attachments.length} attachment${row.attachments.length === 1 ? "" : "s"}`
              : "You owe a reply"}
          </div>
        )}
        <div className="tri-row-actions">
          <button
            type="button"
            onClick={(event) => {
              event.stopPropagation();
              onTrash();
            }}
          >
            Delete
          </button>
          <button
            type="button"
            onClick={(event) => {
              event.stopPropagation();
              onFile();
            }}
          >
            Archive
          </button>
          <button
            type="button"
            onClick={(event) => {
              event.stopPropagation();
              onAtlas();
            }}
          >
            Atlas
          </button>
          <button
            type="button"
            onClick={(event) => {
              event.stopPropagation();
              onOpen();
            }}
          >
            Open
          </button>
        </div>
      </div>
    </div>
  );
}
