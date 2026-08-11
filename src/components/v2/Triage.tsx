"use client";

import { useCallback, useRef, useState } from "react";
import { Archive, Download, Trash2 } from "lucide-react";
import type { ConversationRow, DeleteRow, InboxView } from "@/lib/v2/view/types";
import type { Command } from "@/lib/v2/commands/types";
import { commandFor } from "./triage-command";

/**
 * TRIAGE — the table, restored.
 *
 * From and Subject stay their own columns, distinct from Seer's one-line read;
 * columns resize by dragging their edge; each section carries a bulk action and
 * every row an Archive and a Delete. Sections are the server's decision
 * buckets — the client never decides what is deletable.
 *
 * Delete is offered only where the server minted a signed token for it. Rows it
 * would not authorize get Archive alone, so a bulk action can never turn into a
 * delete the safety layer refused.
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

/**
 * The element that actually scrolls this list — the table's own container on
 * desktop, an ancestor on mobile. Adjusting the wrong one is a silent no-op.
 */
function scrollParent(node: HTMLElement | null): HTMLElement | null {
  for (let el = node; el; el = el.parentElement) {
    const style = getComputedStyle(el);
    const scrollable = /(auto|scroll|overlay)/.test(
      style.overflowY + style.overflow,
    );
    if (scrollable && el.scrollHeight > el.clientHeight) return el;
  }
  return (document.scrollingElement as HTMLElement | null) ?? null;
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
  // Narrow screens start with tighter columns so the table fits without an
  // immediate sideways scroll; dragging still works from there. MailApp renders
  // Triage only after the view has loaded on the client, so reading window here
  // cannot desynchronise a server render.
  const { widths, start } = useColumnWidths(
    typeof window !== "undefined" && window.innerWidth < 700
      ? [110, 150, 170, 44]
      : [200, 280, 320, 64],
  );
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const [busy, setBusy] = useState(false);

  const deletable: DeleteRow[] = view.safeToDelete;
  const needsLook: ConversationRow[] = view.undecided;
  const records: ConversationRow[] = view.records;
  const totalRows = deletable.length + needsLook.length + records.length;

  /**
   * Hold the list still across an update: remember the topmost row that will
   * survive, then restore its on-screen position once the rows have gone.
   */
  const holdPlace = (removing: Set<string>) => {
    const box = scrollRef.current;
    if (!box) return () => {};
    const listTop = box.getBoundingClientRect().top;
    let anchor: { id: string; top: number } | null = null;
    for (const el of Array.from(
      box.querySelectorAll<HTMLElement>("[data-row-id]"),
    )) {
      const id = el.dataset.rowId;
      if (!id || removing.has(id)) continue;
      const top = el.getBoundingClientRect().top;
      if (top >= listTop) {
        anchor = { id, top };
        break;
      }
    }
    return () => {
      if (!anchor) return;
      const el = box.querySelector<HTMLElement>(
        `[data-row-id="${CSS.escape(anchor.id)}"]`,
      );
      const scroller = scrollParent(box);
      if (!el || !scroller) return;
      const moved = el.getBoundingClientRect().top - anchor.top;
      if (moved) scroller.scrollTop += moved;
    };
  };

  const withoutRows = (ids: Set<string>) => (v: InboxView) => ({
    ...v,
    safeToDelete: v.safeToDelete.filter((r) => !ids.has(r.conversationId)),
    undecided: v.undecided.filter((r) => !ids.has(r.conversationId)),
    records: v.records.filter((r) => !ids.has(r.conversationId)),
  });

  /**
   * Apply one action across rows. Commands go one at a time so a single
   * failure cannot take the rest of the batch with it.
   */
  const clearRows = async (rows: Row[], mode: "archive" | "trash") => {
    if (rows.length === 0 || busy) return;
    setBusy(true);
    const restore = holdPlace(new Set(rows.map((r) => r.conversationId)));
    try {
      for (const row of rows) {
        await dispatch(
          commandFor(row, mode),
          withoutRows(new Set([row.conversationId])),
        );
      }
    } finally {
      setBusy(false);
      requestAnimationFrame(restore);
    }
  };

  const Resizer = ({ index }: { index: number }) => (
    <span
      onMouseDown={start(index)}
      className="absolute right-0 top-0 h-full w-1.5 cursor-col-resize select-none hover:bg-[var(--brand)]"
      aria-hidden
    />
  );

  const section = (
    label: string,
    rows: Row[],
    primary: "archive" | "trash",
  ) =>
    rows.length === 0 ? null : (
      <tbody key={label}>
        <tr className="border-b border-[var(--border)] bg-[var(--card)]">
          <th
            colSpan={3}
            className="px-4 py-1.5 text-left text-[12px] font-bold text-[var(--fg-strong)]"
          >
            {label}
            <span className="ml-1 font-normal">· {rows.length}</span>
          </th>
          <td colSpan={2} className="px-4 py-1.5">
            <div className="flex items-center justify-end gap-3 text-[12px] font-bold">
              <button
                type="button"
                disabled={busy}
                onClick={() => clearRows(rows, "archive")}
                className="text-[var(--fg-strong)] hover:underline disabled:opacity-50"
              >
                Archive these
              </button>
              {primary === "trash" && (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => clearRows(rows, "trash")}
                  className="text-[var(--fg-strong)] hover:underline disabled:opacity-50"
                >
                  Delete these
                </button>
              )}
            </div>
          </td>
        </tr>
        {rows.map((row) => (
          <tr
            key={row.conversationId}
            data-row-id={row.conversationId}
            className="border-b border-[var(--border)] align-top hover:bg-[var(--row-hover)]"
          >
            <td className="px-4 py-2 text-[14px] text-[var(--fg-strong)]">
              <span className="line-clamp-2">{row.from || "—"}</span>
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
            </td>
            <td className="whitespace-nowrap px-2 py-2 text-right text-[12px] text-[var(--fg)]">
              {shortTime(row.at)}
            </td>
            <td className="px-4 py-2">
              <div className="flex items-center justify-end gap-1">
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => clearRows([row], "archive")}
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
                    onClick={() => clearRows([row], "trash")}
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
        ))}
      </tbody>
    );

  return (
    <div
      ref={scrollRef}
      className="-mx-4 min-h-0 flex-1 overflow-auto text-[var(--fg)]"
    >
      <header className="flex items-baseline justify-between gap-3 border-b border-[var(--border)] px-4 py-3">
        <div>
          <h1 className="text-[17px] font-bold text-[var(--fg-strong)]">
            Triage
          </h1>
          <p className="text-[14px] text-[var(--fg)]">
            {totalRows} to clear
            {records.length ? ` · ${records.length} to close` : ""}
            {view.coverage.pending
              ? ` · ${view.coverage.pending} still being read`
              : ""}
          </p>
        </div>
        <a
          href="/api/export/inbox"
          className="flex shrink-0 items-center gap-1 text-[12px] text-[var(--fg)] hover:text-[var(--fg-strong)]"
        >
          <Download className="h-4 w-4" />
          Export
        </a>
      </header>

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
            <tr className="border-b border-[var(--border)] text-[12px] font-bold text-[var(--fg-strong)]">
              <th className="relative px-4 py-2 text-left">
                From
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
          {section("Safe to delete", deletable, "trash")}
          {section("Needs a call · maybe a matter", needsLook, "archive")}
          {section("Close out — records", records, "archive")}
        </table>
      )}
    </div>
  );
}
