"use client";

import { useCallback, useMemo, useRef, useState } from "react";
import { Archive, Download, Trash2, X } from "lucide-react";
import type { ConversationRow, InboxView } from "@/lib/v2/view/types";
import type { Command } from "@/lib/v2/commands/types";
import { commandFor } from "./triage-command";
import {
  commandsForSelection,
  deletableCount,
  groupState,
  pruneSelection,
  rangeSelect,
  setGroup,
  toggleOne,
} from "./triage-select";

/**
 * TRIAGE — the categorised table with Gmail-style bulk select.
 *
 * Rows group first by SECTION — the part of the business the work belongs to
 * ("sales — new requests", "hr", "recruiting"), filed by the server against the
 * user's own registry — and then into "Safe to delete" and "Keep · review".
 * Grouping by the sender's company instead would scatter one function's work
 * across a dozen headings.
 *
 * Selection follows the Gmail model: a checkbox on every row, one on each
 * section, shift-click for a range, and a sticky toolbar that appears with the
 * count and the actions. It is the most obvious of the bulk patterns and the
 * only one that works without hover, which matters on a phone.
 *
 * Deleting is authorised solely by the signed token the server minted, so a
 * bulk action can never destroy mail the safety layer vetoed.
 */

function shortTime(iso?: string): string {
  if (!iso) return "";
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return "";
  const mins = Math.floor((Date.now() - t) / 60_000);
  if (mins < 60) return `${Math.max(1, mins)}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d`;
  return new Date(t).toLocaleDateString([], { month: "short", day: "numeric" });
}

/** The user's own heading, verbatim — see the note in Atlas. */
function sectionLabel(name: string): string {
  return name;
}

/** Draggable column widths (px). Actions is fixed; the rest are resizable. */
function useColumnWidths(initial: number[]) {
  const [widths, setWidths] = useState(initial);
  const drag = useRef<{ index: number; startX: number; startW: number } | null>(
    null,
  );
  const onMove = useCallback((e: MouseEvent) => {
    const d = drag.current;
    if (!d) return;
    const next = Math.max(64, d.startW + (e.clientX - d.startX));
    setWidths((prev) => prev.map((w, i) => (i === d.index ? next : w)));
  }, []);
  const stop = useCallback(() => {
    drag.current = null;
    window.removeEventListener("mousemove", onMove);
    window.removeEventListener("mouseup", stop);
  }, [onMove]);
  const start = useCallback(
    (index: number) => (e: React.MouseEvent) => {
      e.preventDefault();
      drag.current = { index, startX: e.clientX, startW: widths[index] };
      window.addEventListener("mousemove", onMove);
      window.addEventListener("mouseup", stop);
    },
    [widths, onMove, stop],
  );
  return { widths, start };
}

type Row = ConversationRow & { deleteToken?: string };

type Section = { name: string; toDelete: Row[]; toKeep: Row[] };

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
      checked={state === "all"}
      ref={(el) => {
        if (el) el.indeterminate = state === "some";
      }}
      onClick={(e) => e.stopPropagation()}
      onChange={(e) =>
        onChange(e.target.checked, (e.nativeEvent as MouseEvent).shiftKey)
      }
      className="h-4 w-4 shrink-0 cursor-pointer accent-[var(--primary)]"
    />
  );
}

export function Triage({
  view,
  dispatch,
}: {
  view: InboxView;
  dispatch: (
    command: Command,
    optimistic?: (v: InboxView) => InboxView,
  ) => Promise<unknown>;
}) {
  const { widths, start } = useColumnWidths(
    typeof window !== "undefined" && window.innerWidth < 700
      ? [110, 150, 170, 44]
      : [200, 280, 320, 64],
  );
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const [busy, setBusy] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const anchorRef = useRef<number | null>(null);

  // Group by the section the server filed each row under, in the user's own
  // registry order — the same order the whiteboard uses, so the two views read
  // the same way and sections never reshuffle under the cursor.
  const sections = useMemo<Section[]>(() => {
    const map = new Map<string, Section>();
    const at = (name: string): Section => {
      const existing = map.get(name);
      if (existing) return existing;
      const created: Section = { name, toDelete: [], toKeep: [] };
      map.set(name, created);
      return created;
    };
    for (const row of view.safeToDelete) at(row.category).toDelete.push(row);
    for (const row of [...view.undecided, ...view.records]) {
      at(row.category).toKeep.push(row);
    }
    const registry = view.functions;
    const ordered = [
      ...registry.filter((name) => map.has(name)),
      ...[...map.keys()]
        .filter((name) => !registry.includes(name) && name !== "unfiled")
        .sort(),
      ...(map.has("unfiled") ? ["unfiled"] : []),
    ];
    return ordered.map((name) => map.get(name) as Section);
  }, [view.safeToDelete, view.undecided, view.records, view.functions]);

  /** Every row in display order — the sequence a shift-click range spans. */
  const allRows = useMemo<Row[]>(
    () => sections.flatMap((s) => [...s.toDelete, ...s.toKeep]),
    [sections],
  );
  const allIds = useMemo(
    () => allRows.map((r) => r.conversationId),
    [allRows],
  );

  // A tick on a row that has since been cleared must not survive to act on
  // something else later.
  const liveSelection = useMemo(
    () => pruneSelection(selected, allIds),
    [selected, allIds],
  );

  const totalRows = allRows.length;
  const selectedCount = liveSelection.size;
  const canDelete = deletableCount(allRows, liveSelection);

  const onRowCheck = (index: number) => (checked: boolean, shift: boolean) => {
    const id = allIds[index];
    setSelected((prev) => {
      const anchor = anchorRef.current;
      if (shift && anchor !== null) return rangeSelect(prev, allIds, anchor, index);
      return toggleOne(prev, id);
    });
    anchorRef.current = index;
  };

  const withoutRows = (ids: Set<string>) => (v: InboxView) => ({
    ...v,
    safeToDelete: v.safeToDelete.filter((r) => !ids.has(r.conversationId)),
    undecided: v.undecided.filter((r) => !ids.has(r.conversationId)),
    records: v.records.filter((r) => !ids.has(r.conversationId)),
  });

  /** Run commands one at a time so one failure cannot take the batch with it. */
  const run = async (
    items: { command: Command; conversationId: string }[],
  ) => {
    if (items.length === 0 || busy) return;
    setBusy(true);
    try {
      for (const item of items) {
        await dispatch(
          item.command,
          withoutRows(new Set([item.conversationId])),
        );
      }
    } finally {
      setBusy(false);
      setSelected(new Set());
      anchorRef.current = null;
    }
  };

  const actOnSelection = (mode: "archive" | "trash") =>
    run(commandsForSelection(allRows, liveSelection, mode));

  const actOnRow = (row: Row, mode: "archive" | "trash") =>
    run([
      { command: commandFor(row, mode), conversationId: row.conversationId },
    ]);

  const Resizer = ({ index }: { index: number }) => (
    <span
      onMouseDown={start(index)}
      className="absolute right-0 top-0 h-full w-1.5 cursor-col-resize select-none hover:bg-[var(--brand)]"
      aria-hidden
    />
  );

  let rowIndex = -1;

  const bucket = (rows: Row[], label: string) =>
    rows.length === 0 ? null : (
      <>
        <tr>
          <td
            colSpan={5}
            className="px-4 pb-1 pt-3 text-[12px] font-medium text-[var(--muted)]"
          >
            {label}
            <span className="font-normal"> · {rows.length}</span>
          </td>
        </tr>
        {rows.map((row) => {
          rowIndex += 1;
          const index = rowIndex;
          const checked = liveSelection.has(row.conversationId);
          return (
            <tr
              key={row.conversationId}
              data-row-id={row.conversationId}
              className={`align-top transition-colors ${
                checked ? "bg-[var(--selection)]" : "hover:bg-[var(--row-hover)]"
              }`}
            >
              <td className="py-2 pl-4 pr-1">
                <div className="flex items-start gap-2">
                  <Check
                    state={checked ? "all" : "none"}
                    onChange={onRowCheck(index)}
                    label={`Select ${row.subject || "conversation"}`}
                  />
                  <span className="line-clamp-2 text-[14px] text-[var(--fg-strong)]">
                    {row.from || "—"}
                  </span>
                </div>
              </td>
              <td className="px-2 py-2 text-[14px] text-[var(--fg-strong)]">
                <a
                  href={row.nativeUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="block w-full text-left hover:underline"
                >
                  <span className="line-clamp-2">
                    {row.subject || "(no subject)"}
                  </span>
                </a>
              </td>
              <td className="px-2 py-2 text-[14px] text-[var(--fg)]">
                <span className="line-clamp-2">{row.summary}</span>
                {row.counterparty && (
                  <span className="ml-1 text-[12px] text-[var(--muted)]">
                    · {row.counterparty}
                  </span>
                )}
              </td>
              <td className="whitespace-nowrap px-2 py-2 text-right text-[12px] text-[var(--fg)]">
                {shortTime(row.at)}
              </td>
              <td className="px-4 py-2">
                <div className="flex items-center justify-end gap-1">
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => actOnRow(row, "archive")}
                    aria-label="Archive"
                    title="Archive"
                    className="flex h-8 w-8 items-center justify-center rounded-md text-[var(--fg)] hover:bg-[var(--card)] disabled:opacity-50"
                  >
                    <Archive className="h-4 w-4" />
                  </button>
                  {row.deleteToken && (
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => actOnRow(row, "trash")}
                      aria-label="Delete"
                      title="Delete"
                      className="flex h-8 w-8 items-center justify-center rounded-md text-[var(--fg)] hover:bg-[var(--card)] disabled:opacity-50"
                    >
                      <Trash2 className="h-4 w-4" />
                    </button>
                  )}
                </div>
              </td>
            </tr>
          );
        })}
      </>
    );

  return (
    <div
      ref={scrollRef}
      className="-mx-4 min-h-0 flex-1 overflow-auto text-[var(--fg)]"
    >
      <header className="flex items-center justify-between gap-3 px-4 pb-4 pt-2">
        <div>
          <h1 className="text-[24px] font-semibold tracking-[-0.01em] text-[var(--fg-strong)]">
            Triage
          </h1>
          <p className="mt-0.5 text-[14px] text-[var(--muted)]">
            {totalRows} to clear · {sections.length} sections
            {view.coverage.pending
              ? ` · ${view.coverage.pending} still being read`
              : ""}
          </p>
        </div>
        <a
          href="/api/export/inbox"
          className="flex shrink-0 items-center gap-1.5 rounded-full px-3 py-1.5 text-[13px] text-[var(--muted)] transition-colors hover:bg-[var(--row-hover)] hover:text-[var(--fg-strong)]"
        >
          <Download className="h-4 w-4" />
          Export
        </a>
      </header>

      {/* The toolbar only exists while something is ticked, so it costs no
          space the rest of the time, and it sticks so the actions stay in
          reach however far down a long list you have scrolled. */}
      {selectedCount > 0 && (
        <div
          role="toolbar"
          aria-label="Actions for selected conversations"
          className="sticky top-0 z-20 mx-2 mb-2 flex flex-wrap items-center gap-2 rounded-2xl bg-[var(--card)] px-3 py-2 shadow-[0_1px_3px_rgba(0,0,0,0.06)] backdrop-blur"
        >
          <span className="px-1 text-[13px] font-medium text-[var(--fg-strong)]">
            {selectedCount} selected
          </span>
          <button
            type="button"
            disabled={busy}
            onClick={() => actOnSelection("archive")}
            className="flex items-center gap-1.5 rounded-full bg-[var(--bg)] px-3 py-1.5 text-[13px] font-medium text-[var(--fg-strong)] transition-colors hover:bg-[var(--row-hover)] disabled:opacity-40"
          >
            <Archive className="h-4 w-4" />
            Archive
          </button>
          <button
            type="button"
            disabled={busy || canDelete === 0}
            onClick={() => actOnSelection("trash")}
            title={
              canDelete === selectedCount
                ? "Delete the selected conversations"
                : "Only conversations Seer cleared for deletion will be deleted"
            }
            className="flex items-center gap-1.5 rounded-full bg-[var(--bg)] px-3 py-1.5 text-[13px] font-medium text-[var(--accent)] transition-colors hover:bg-[var(--row-hover)] disabled:opacity-40"
          >
            <Trash2 className="h-4 w-4" />
            Delete{canDelete !== selectedCount ? ` (${canDelete})` : ""}
          </button>
          {canDelete !== selectedCount && (
            <span className="text-[12.5px] text-[var(--muted)]">
              {selectedCount - canDelete} of these aren&apos;t cleared for
              deletion
            </span>
          )}
          <button
            type="button"
            onClick={() => setSelected(new Set())}
            className="ml-auto flex items-center gap-1 rounded-full px-2.5 py-1.5 text-[12.5px] text-[var(--muted)] transition-colors hover:bg-[var(--row-hover)] hover:text-[var(--fg-strong)]"
          >
            <X className="h-4 w-4" />
            Clear
          </button>
        </div>
      )}

      {totalRows === 0 ? (
        <p className="px-4 py-6 text-[14px] text-[var(--fg)]">
          Nothing to clear. Everything left in the inbox is a matter.
        </p>
      ) : (
        <table className="w-full table-fixed border-collapse text-left text-[var(--fg)]">
          <colgroup>
            <col style={{ width: widths[0] }} />
            <col style={{ width: widths[1] }} />
            <col style={{ width: widths[2] }} />
            <col style={{ width: widths[3] }} />
            <col />
          </colgroup>
          <thead>
            <tr className="text-[12px] font-medium text-[var(--muted)]">
              <th className="relative py-2 pl-4 pr-1 text-left">
                <span className="flex items-center gap-2">
                  <Check
                    state={groupState(liveSelection, allIds)}
                    onChange={(checked) =>
                      setSelected((prev) => setGroup(prev, allIds, checked))
                    }
                    label="Select all conversations"
                  />
                  From
                </span>
                <Resizer index={0} />
              </th>
              <th className="relative px-2 py-2 text-left">
                Subject
                <Resizer index={1} />
              </th>
              <th className="relative px-2 py-2 text-left">
                Seer&apos;s read
                <Resizer index={2} />
              </th>
              <th className="relative px-2 py-2 text-right">
                When
                <Resizer index={3} />
              </th>
              <th className="px-4 py-2 text-right">Actions</th>
            </tr>
          </thead>
          {sections.map((section) => {
            const ids = [...section.toDelete, ...section.toKeep].map(
              (r) => r.conversationId,
            );
            return (
              <tbody key={section.name}>
                <tr>
                  <th
                    colSpan={5}
                    className="px-4 pb-1 pt-6 text-left text-[13px] font-semibold uppercase tracking-[0.06em] text-[var(--muted)]"
                  >
                    <span className="flex items-center gap-2">
                      <Check
                        state={groupState(liveSelection, ids)}
                        onChange={(checked) =>
                          setSelected((prev) => setGroup(prev, ids, checked))
                        }
                        label={`Select all in ${sectionLabel(section.name)}`}
                      />
                      {sectionLabel(section.name)}
                      <span className="font-normal normal-case tracking-normal">
                        · {ids.length}
                      </span>
                    </span>
                  </th>
                </tr>
                {bucket(section.toDelete, "Safe to delete")}
                {bucket(section.toKeep, "Keep · review")}
              </tbody>
            );
          })}
        </table>
      )}
    </div>
  );
}
