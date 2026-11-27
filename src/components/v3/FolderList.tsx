"use client";

import * as React from "react";
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import { Archive, MailOpen, RotateCcw, Trash2, X } from "lucide-react";
import type { Command, CommandResult } from "@/lib/v2/commands/types";
import type { MailboxRow, MailboxView } from "@/lib/v3/mailbox/types";
import { userCommandFor } from "@/components/v2/triage-command";
import { commandsForSelection, groupState } from "@/components/v2/triage-select";
import {
  EMPTY_SELECTION,
  reduceSelection,
  type Selection,
  type SelectionAction,
} from "./list-selection";
import { Check } from "./ListCheck";
import { rowLabel } from "./useMailbox";

/** How long a touch must rest on a row before it starts a selection. */
const LONG_PRESS_MS = 450;
/** Movement past this many pixels is a scroll, not a press. */
const LONG_PRESS_SLOP = 10;

function shortTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat([], { month: "short", day: "numeric" }).format(date);
}

/**
 * Press and hold to start selecting, as the Gmail app does. Touch only: on a
 * desktop a slow click is still a click, and turning one into a selection
 * would punish anyone who does not release a mouse button quickly.
 */
function useLongPress(onLongPress: () => void) {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const origin = useRef<{ x: number; y: number } | null>(null);
  const fired = useRef(false);

  const cancel = useCallback(() => {
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = null;
    origin.current = null;
  }, []);

  useEffect(() => cancel, [cancel]);

  const handlers = {
    onPointerDown: (e: React.PointerEvent) => {
      if (e.pointerType === "mouse") return;
      fired.current = false;
      origin.current = { x: e.clientX, y: e.clientY };
      timer.current = setTimeout(() => {
        fired.current = true;
        onLongPress();
      }, LONG_PRESS_MS);
    },
    onPointerMove: (e: React.PointerEvent) => {
      const start = origin.current;
      if (!start) return;
      if (Math.hypot(e.clientX - start.x, e.clientY - start.y) > LONG_PRESS_SLOP) {
        cancel();
      }
    },
    onPointerUp: cancel,
    onPointerCancel: cancel,
    onContextMenu: (e: React.MouseEvent) => {
      if (fired.current) e.preventDefault();
    },
  };

  return { handlers, fired };
}

type ListEntry = { kind: "row"; key: string; row: MailboxRow; index: number };

/**
 * A row's main hit area. It opens the conversation normally, but once a
 * selection is under way it ticks instead — in a selection you are aiming at
 * rows, not at the small box on the left of them, and a stray tap that throws
 * away the selection by navigating is the thing that makes bulk clearing feel
 * hostile on a phone.
 */
function RowButton({
  row,
  index,
  checked,
  selecting,
  onToggle,
  onOpen,
  onPrefetch,
  children,
}: {
  row: MailboxRow;
  index: number;
  checked: boolean;
  selecting: boolean;
  onToggle: (index: number, shift: boolean) => void;
  onOpen: (row: MailboxRow) => void;
  onPrefetch: (conversationId: string) => void;
  children: React.ReactNode;
}) {
  const { handlers, fired } = useLongPress(() => onToggle(index, false));
  return (
    <button
      type="button"
      className="mail-list-open mail-focus-ring"
      aria-label={
        selecting
          ? `${checked ? "Deselect" : "Select"} ${rowLabel(row)}`
          : `Open ${rowLabel(row)}`
      }
      aria-pressed={selecting ? checked : undefined}
      onClick={(event) => {
        // The press that started the selection must not also count as a tap.
        if (fired.current) {
          fired.current = false;
          return;
        }
        if (selecting) {
          onToggle(index, event.shiftKey);
          return;
        }
        onPrefetch(row.conversationId);
        onOpen(row);
      }}
      onFocus={() => onPrefetch(row.conversationId)}
      onMouseEnter={() => onPrefetch(row.conversationId)}
      {...handlers}
    >
      {children}
    </button>
  );
}

export function FolderList({
  view,
  refreshing,
  onOpen,
  onPrefetch,
  onCommands,
  initialSelectedIds,
}: {
  view: MailboxView;
  refreshing: boolean;
  onOpen: (row: MailboxRow) => void;
  onPrefetch: (conversationId: string) => void;
  onCommands: (commands: Command[]) => Promise<CommandResult[]>;
  /** Seeds the selection so the bulk toolbar can be rendered without a click. */
  initialSelectedIds?: string[];
}) {
  const primaryLabel = view.folder === "trash" ? "Restore" : "Archive";
  const PrimaryIcon = view.folder === "trash" ? RotateCcw : Archive;
  const [busy, setBusy] = useState(false);

  const allIds = useMemo(
    () => view.rows.map((row) => row.conversationId),
    [view.rows],
  );
  const entries = useMemo<ListEntry[]>(
    () =>
      view.rows.map((row, index) => ({
        kind: "row" as const,
        key: row.conversationId,
        row,
        index,
      })),
    [view.rows],
  );
  const allIdsRef = useRef(allIds);
  allIdsRef.current = allIds;
  const [selection, dispatchSelection] = useReducer(
    (state: Selection, action: SelectionAction) =>
      reduceSelection(state, action, allIdsRef.current),
    initialSelectedIds,
    (seed): Selection =>
      seed && seed.length > 0
        ? { ids: new Set(seed), anchor: null }
        : EMPTY_SELECTION,
  );

  // A tick on a row that has since been cleared must not survive to act on
  // something else later.
  useEffect(() => {
    dispatchSelection({ kind: "prune" });
  }, [allIds]);

  const liveSelection = selection.ids as Set<string>;
  const selectedCount = liveSelection.size;
  const selecting = selectedCount > 0;
  const selectAllState = groupState(liveSelection, allIds);

  // Escape drops the selection, the way it does in every mail client — being
  // stuck in selection mode with no way out but un-ticking rows one by one is
  // the sort of thing that makes bulk actions feel dangerous.
  useEffect(() => {
    if (!selecting) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") dispatchSelection({ kind: "clear" });
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [selecting]);

  const toggleRow = (index: number, shift: boolean) => {
    const id = allIdsRef.current[index];
    if (id === undefined) return;
    dispatchSelection({ kind: "row", index, shift });
    onPrefetch(id);
  };

  const onRowCheck = (index: number) => (_checked: boolean, shift: boolean) =>
    toggleRow(index, shift);

  const run = async (items: { command: Command; conversationId: string }[]) => {
    if (items.length === 0 || busy) return;
    setBusy(true);
    try {
      await onCommands(items.map((item) => item.command));
    } catch {
      // The toast owns the failure message; the list is re-read either way.
    } finally {
      setBusy(false);
      dispatchSelection({ kind: "clear" });
    }
  };

  const actPrimary = () => {
    if (view.folder === "trash") {
      const picked = view.rows.filter((row) => liveSelection.has(row.conversationId));
      void run(
        picked.map((row) => ({
          command: { type: "restore" as const, conversationId: row.conversationId },
          conversationId: row.conversationId,
        })),
      );
      return;
    }
    void run(commandsForSelection(view.rows, liveSelection, "archive"));
  };

  const actDelete = () =>
    void run(commandsForSelection(view.rows, liveSelection, "trash"));

  const actMarkUnread = () => {
    const picked = view.rows.filter((row) => liveSelection.has(row.conversationId));
    void run(
      picked.map((row) => ({
        command: { type: "markUnread" as const, conversationId: row.conversationId },
        conversationId: row.conversationId,
      })),
    );
  };

  const actOnRow = (row: MailboxRow, mode: "archive" | "restore" | "trash") => {
    if (mode === "restore") {
      void run([
        {
          command: { type: "restore", conversationId: row.conversationId },
          conversationId: row.conversationId,
        },
      ]);
      return;
    }
    // The user is looking straight at this row and pressed the button.
    void run([
      { command: userCommandFor(row, mode), conversationId: row.conversationId },
    ]);
  };

  return (
    <section className="mail-folder-layout" aria-label={`${view.folder} messages`}>
      <header className="mail-list-header">
        <div>
          <h1>{view.folder[0].toUpperCase() + view.folder.slice(1)}</h1>
          <p>
            {view.total} {view.total === 1 ? "conversation" : "conversations"}
            {refreshing ? " · Updating…" : ""}
          </p>
        </div>
      </header>

      {/* The master checkbox lives in a bar above the list and stays there, as
          it does in Gmail and Outlook, rather than posing as the first row of
          the list. The actions join it in the same bar once something is
          ticked, so the controls never move under the cursor. */}
      {/* The bar belongs to selecting, not to the list. An inbox that always
          shows a "Select all" is a spreadsheet; long-pressing a row is what
          says the user wants to act on several at once. */}
      {selecting && view.rows.length > 0 && (
        <div
          className="mail-bulk-toolbar"
          data-selecting="true"
          role="toolbar"
          aria-label="Selected message actions"
        >
          <Check
            state={selectAllState}
            onChange={(checked) => dispatchSelection({ kind: "all", checked })}
            label="Select all conversations"
          />
          <span className="mail-bulk-count" aria-live="polite">
            {selecting ? `${selectedCount} selected` : "Select all"}
          </span>
          {selecting && view.folder !== "sent" && (
            <button
              type="button"
              className="mail-action mail-focus-ring"
              disabled={busy}
              onClick={actPrimary}
            >
              <PrimaryIcon aria-hidden className="mail-bulk-icon" />
              {primaryLabel}
            </button>
          )}
          {selecting && (
            <>
              <button
                type="button"
                className="mail-action mail-focus-ring"
                disabled={busy}
                title="Delete the selected conversations"
                onClick={actDelete}
              >
                <Trash2 aria-hidden className="mail-bulk-icon" />
                Delete
              </button>
              <button
                type="button"
                className="mail-action mail-focus-ring"
                disabled={busy}
                onClick={actMarkUnread}
              >
                <MailOpen aria-hidden className="mail-bulk-icon" />
                Mark unread
              </button>
              <button
                type="button"
                className="mail-bulk-clear mail-focus-ring"
                onClick={() => dispatchSelection({ kind: "clear" })}
              >
                <X aria-hidden className="mail-bulk-icon" />
                Clear selection
              </button>
            </>
          )}
        </div>
      )}

      {view.rows.length === 0 ? (
        <p className="mail-empty">Nothing here yet.</p>
      ) : (
        <ul className="mail-list">
          {entries.map((entry) => {
            const { row, index } = entry;
            const checked = liveSelection.has(row.conversationId);
            return (
              <li
                key={entry.key}
                className="mail-list-row"
                data-unread={row.isUnread ? "true" : "false"}
                data-selected={checked ? "true" : "false"}
              >
                {selecting && (
                  <Check
                    state={checked ? "all" : "none"}
                    onChange={onRowCheck(index)}
                    label={`Select ${rowLabel(row)}`}
                  />
                )}
                <RowButton
                  row={row}
                  index={index}
                  checked={checked}
                  selecting={selecting}
                  onToggle={toggleRow}
                  onOpen={onOpen}
                  onPrefetch={onPrefetch}
                >
                  <>
                      <span className="mail-list-main">
                        <span className="mail-list-sender">
                          {row.senderDisplayName || "Unknown sender"}
                        </span>
                        <span className="mail-list-subject">
                          {row.subject || "(no subject)"}
                        </span>
                        <span className="mail-list-snippet">
                          {row.snippet || "No preview available"}
                        </span>
                      </span>
                      <span className="mail-list-meta">
                        <time dateTime={row.timestamp}>{shortTime(row.timestamp)}</time>
                        {row.attachments.length > 0 && (
                          <span aria-label={`${row.attachments.length} attachments`}>
                            · {row.attachments.length} file
                            {row.attachments.length === 1 ? "" : "s"}
                          </span>
                        )}
                      </span>
                  </>
                </RowButton>
                {view.folder !== "sent" && (
                  <span className="mail-list-actions">
                    <button
                      type="button"
                      className="mail-action mail-list-action mail-focus-ring"
                      aria-label={`${primaryLabel} ${row.subject || "conversation"}`}
                      title={primaryLabel}
                      disabled={busy}
                      onClick={() =>
                        actOnRow(row, view.folder === "trash" ? "restore" : "archive")
                      }
                    >
                      <PrimaryIcon aria-hidden />
                    </button>
                    {(
                      <button
                        type="button"
                        className="mail-action mail-list-action mail-focus-ring"
                        aria-label={`Delete ${row.subject || "conversation"}`}
                        title="Delete"
                        disabled={busy}
                        onClick={() => actOnRow(row, "trash")}
                      >
                        <Trash2 aria-hidden />
                      </button>
                    )}
                  </span>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
