"use client";

import * as React from "react";
import { useEffect, useMemo, useRef, useState } from "react";
import { Archive, MailOpen, RotateCcw, Trash2, X } from "lucide-react";
import type { Command, CommandResult } from "@/lib/v2/commands/types";
import type { Disposition } from "@/lib/v3/mailbox/triage-rank";
import { triageGroupHint, triageGroupLabel } from "@/lib/v3/mailbox/triage-rank";
import type { MailboxRow, MailboxSort, MailboxView } from "@/lib/v3/mailbox/types";
import { commandFor } from "@/components/v2/triage-command";
import {
  commandsForSelection,
  deletableCount,
  groupState,
  pruneSelection,
  rangeSelect,
  setGroup,
  toggleOne,
} from "@/components/v2/triage-select";
import { rowLabel } from "./useMailbox";

function shortTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat([], { month: "short", day: "numeric" }).format(date);
}

/** A checkbox that can show the third, "some of this group" state. */
function Check({
  state,
  onChange,
  label,
}: {
  state: "all" | "some" | "none";
  onChange: (checked: boolean, shift: boolean) => void;
  label: string;
}) {
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
      onClick={(e) => e.stopPropagation()}
      onChange={(e) =>
        onChange(e.target.checked, (e.nativeEvent as MouseEvent).shiftKey)
      }
      className="mail-list-checkbox mail-focus-ring"
    />
  );
}

type ListEntry =
  | {
      kind: "heading";
      key: string;
      disposition: Disposition;
      ids: string[];
      label: string;
      hint: string;
    }
  | { kind: "row"; key: string; row: MailboxRow; index: number };

/**
 * Walk a pre-sorted triage list and emit a heading whenever the server's
 * deleteRank changes. Labels come from disposition; the rank itself is never
 * recomputed here — only the server decides what is deletable.
 */
function listEntries(rows: MailboxRow[], triage: boolean): ListEntry[] {
  if (!triage) {
    return rows.map((row, index) => ({
      kind: "row" as const,
      key: row.conversationId,
      row,
      index,
    }));
  }
  const entries: ListEntry[] = [];
  let i = 0;
  while (i < rows.length) {
    const { deleteRank, disposition } = rows[i];
    const start = i;
    i += 1;
    while (i < rows.length && rows[i].deleteRank === deleteRank) i += 1;
    const ids = rows.slice(start, i).map((row) => row.conversationId);
    entries.push({
      kind: "heading",
      key: `group-${deleteRank}-${disposition}`,
      disposition,
      ids,
      label: triageGroupLabel(disposition),
      hint: triageGroupHint(disposition),
    });
    for (let j = start; j < i; j += 1) {
      entries.push({
        kind: "row",
        key: rows[j].conversationId,
        row: rows[j],
        index: j,
      });
    }
  }
  return entries;
}

export function FolderList({
  view,
  refreshing,
  sort,
  onSortChange,
  onOpen,
  onPrefetch,
  onCommands,
  initialSelectedIds,
}: {
  view: MailboxView;
  refreshing: boolean;
  sort: MailboxSort;
  onSortChange?: (sort: MailboxSort) => void;
  onOpen: (row: MailboxRow) => void;
  onPrefetch: (conversationId: string) => void;
  onCommands: (commands: Command[]) => Promise<CommandResult[]>;
  /** Seeds the selection so the bulk toolbar can be rendered without a click. */
  initialSelectedIds?: string[];
}) {
  // Headings describe the rows actually on screen, so they follow the sort the
  // VIEW was built with — not the one the user has just asked for and whose
  // rows have not arrived yet.
  const triage = view.folder === "inbox" && view.sort === "triage";
  const primaryLabel = view.folder === "trash" ? "Restore" : "Archive";
  const PrimaryIcon = view.folder === "trash" ? RotateCcw : Archive;
  const [selected, setSelected] = useState<Set<string>>(
    () => new Set(initialSelectedIds ?? []),
  );
  const [busy, setBusy] = useState(false);
  const anchorRef = useRef<number | null>(null);

  const allIds = useMemo(
    () => view.rows.map((row) => row.conversationId),
    [view.rows],
  );
  const entries = useMemo(
    () => listEntries(view.rows, triage),
    [view.rows, triage],
  );

  useEffect(() => {
    setSelected((current) => {
      const next = pruneSelection(current, allIds);
      if (next.size === current.size && [...next].every((id) => current.has(id))) {
        return current;
      }
      return next;
    });
  }, [allIds]);

  const liveSelection = useMemo(
    () => pruneSelection(selected, allIds),
    [selected, allIds],
  );
  const selectedCount = liveSelection.size;
  const canDelete = deletableCount(view.rows, liveSelection);
  const selectAllState = groupState(liveSelection, allIds);

  const onRowCheck = (index: number) => (checked: boolean, shift: boolean) => {
    const id = allIds[index];
    if (!id) return;
    setSelected((prev) => {
      const anchor = anchorRef.current;
      if (shift && anchor !== null) return rangeSelect(prev, allIds, anchor, index);
      return toggleOne(prev, id);
    });
    anchorRef.current = index;
    onPrefetch(id);
  };

  const run = async (items: { command: Command; conversationId: string }[]) => {
    if (items.length === 0 || busy) return;
    setBusy(true);
    try {
      await onCommands(items.map((item) => item.command));
    } catch {
      // The toast owns the failure message; the list is re-read either way.
    } finally {
      setBusy(false);
      setSelected(new Set());
      anchorRef.current = null;
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
    void run([
      { command: commandFor(row, mode), conversationId: row.conversationId },
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
        {view.folder === "inbox" && onSortChange && (
          <div
            className="mail-sort"
            role="radiogroup"
            aria-label="Sort inbox"
          >
            <button
              type="button"
              role="radio"
              className="mail-sort-option mail-focus-ring"
              aria-checked={sort === "date"}
              data-active={sort === "date" ? "true" : "false"}
              onClick={() => onSortChange("date")}
            >
              Date
            </button>
            <button
              type="button"
              role="radio"
              className="mail-sort-option mail-focus-ring"
              aria-checked={sort === "triage"}
              data-active={sort === "triage" ? "true" : "false"}
              onClick={() => onSortChange("triage")}
            >
              Most likely to delete
            </button>
          </div>
        )}
      </header>

      {selectedCount > 0 && (
        <div
          className="mail-bulk-toolbar"
          role="toolbar"
          aria-label="Selected message actions"
        >
          <span className="mail-bulk-count" aria-live="polite">
            {selectedCount} selected
          </span>
          {view.folder !== "sent" && (
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
          <button
            type="button"
            className="mail-action mail-focus-ring"
            disabled={busy || canDelete === 0}
            title={
              canDelete === selectedCount
                ? "Delete the selected conversations"
                : "Only conversations Seer cleared for deletion will be deleted"
            }
            onClick={actDelete}
          >
            <Trash2 aria-hidden className="mail-bulk-icon" />
            Delete{canDelete !== selectedCount ? ` (${canDelete})` : ""}
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
          {canDelete !== selectedCount && (
            <span className="mail-bulk-hint">
              {canDelete === 0
                ? "None of these are cleared for deletion"
                : `${selectedCount - canDelete} of these aren’t cleared for deletion`}
            </span>
          )}
          <button
            type="button"
            className="mail-bulk-clear mail-focus-ring"
            onClick={() => {
              setSelected(new Set());
              anchorRef.current = null;
            }}
          >
            <X aria-hidden className="mail-bulk-icon" />
            Clear selection
          </button>
        </div>
      )}

      {view.rows.length === 0 ? (
        <p className="mail-empty">Nothing here yet.</p>
      ) : (
        <ul className="mail-list">
          <li className="mail-list-select-all">
            <Check
              state={selectAllState}
              onChange={(checked) =>
                setSelected((prev) => setGroup(prev, allIds, checked))
              }
              label="Select all conversations"
            />
            <span>Select all</span>
          </li>
          {entries.map((entry) => {
            if (entry.kind === "heading") {
              return (
                <li key={entry.key} className="mail-list-group">
                  <Check
                    state={groupState(liveSelection, entry.ids)}
                    onChange={(checked) =>
                      setSelected((prev) => setGroup(prev, entry.ids, checked))
                    }
                    label={`Select all in ${entry.label}`}
                  />
                  <div className="mail-list-group-text">
                    <span className="mail-list-group-label">
                      {entry.label}
                      <span className="mail-list-group-count">
                        {" "}
                        · {entry.ids.length}
                      </span>
                    </span>
                    <span className="mail-list-group-hint">{entry.hint}</span>
                  </div>
                </li>
              );
            }

            const { row, index } = entry;
            const checked = liveSelection.has(row.conversationId);
            return (
              <li
                key={entry.key}
                className="mail-list-row"
                data-unread={row.isUnread ? "true" : "false"}
                data-selected={checked ? "true" : "false"}
              >
                <Check
                  state={checked ? "all" : "none"}
                  onChange={onRowCheck(index)}
                  label={`Select ${rowLabel(row)}`}
                />
                <button
                  type="button"
                  className="mail-list-open mail-focus-ring"
                  aria-label={`Open ${rowLabel(row)}`}
                  onClick={() => {
                    onPrefetch(row.conversationId);
                    onOpen(row);
                  }}
                  onFocus={() => onPrefetch(row.conversationId)}
                  onMouseEnter={() => onPrefetch(row.conversationId)}
                  onTouchStart={() => onPrefetch(row.conversationId)}
                >
                  <span className="mail-list-main">
                    <span className="mail-list-sender">
                      {row.senderDisplayName || "Unknown sender"}
                    </span>
                    <span className="mail-list-subject">
                      {row.subject || "(no subject)"}
                    </span>
                    {triage ? (
                      <>
                        {row.decisionSummary && (
                          <span className="mail-list-decision">
                            {row.decisionSummary}
                          </span>
                        )}
                        {row.category && (
                          <span className="mail-list-category">{row.category}</span>
                        )}
                      </>
                    ) : (
                      <span className="mail-list-snippet">
                        {row.snippet || "No preview available"}
                      </span>
                    )}
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
                </button>
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
                    {row.deleteToken && (
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
