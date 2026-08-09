"use client";

import { useCallback, useMemo, useRef, useState } from "react";
import { Archive, Download, Trash2 } from "lucide-react";
import type { Brief, Matter } from "@/lib/inbox/matters";

function orgRoot(orgUnit: string, functions: string[]): string {
  const lower = (orgUnit ?? "").toLowerCase();
  let best = "";
  for (const fn of functions) {
    const fl = fn.toLowerCase();
    if ((lower === fl || lower.startsWith(`${fl} —`)) && fl.length > best.length) {
      best = fn;
    }
  }
  return best || orgUnit || "Other";
}

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

const DELETE_DISPOSITIONS = new Set(["disposable", "fyi"]);

type Bucket = "review" | "delete";

type TriageRow = {
  id: string;
  threadId: string;
  count?: number;
  category: string;
  from: string;
  subject: string;
  read: string;
  at: string;
  bucket: Bucket;
};

type TriageGroup = {
  category: string;
  review: TriageRow[];
  delete: TriageRow[];
};

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

/**
 * TRIAGE, AS A TABLE (issues #15, #16, #18, #19, #20, #21).
 *
 * - Native From and Subject are their own columns, kept distinct from Seer's
 *   one-line read (#18, #20) — no more mixing the AI summary into the sender.
 * - Columns are resizable by dragging their edge, with even spacing (#19).
 * - Rows group by category, and inside a category the deep read splits them
 *   into "Needs a call / maybe a matter" and "Safe to delete" (#21), each with
 *   a bulk action, plus per-row Archive and Delete.
 * - Every cell is foreground colour — no grey (#16).
 */
export function TriageDigest({
  brief,
  building,
  onOpenEmail,
  onSettle,
  onClear,
}: {
  brief: Brief | null;
  building: boolean;
  onOpenEmail: (id: string) => void;
  onSettle: (matterId: string, settled: boolean) => void;
  onClear: (
    rows: { id: string; threadId: string; count?: number }[],
    reason?: string,
    mode?: "archive" | "trash",
  ) => void;
}) {
  const functions = useMemo(() => brief?.functions ?? [], [brief]);
  const { widths, start } = useColumnWidths([200, 320, 320, 64]);

  const closing = useMemo<Matter[]>(
    () =>
      [...(brief?.pinned ?? []), ...(brief?.matters ?? [])].filter(
        (m) => m.status === "looks-closed",
      ),
    [brief],
  );

  const groups = useMemo<TriageGroup[]>(() => {
    if (!brief) return [];
    const map = new Map<string, TriageGroup>();
    const push = (category: string, row: TriageRow) => {
      const g = map.get(category) ?? { category, review: [], delete: [] };
      (row.bucket === "delete" ? g.delete : g.review).push(row);
      map.set(category, g);
    };

    for (const f of brief.filed ?? []) {
      const bucket: Bucket = DELETE_DISPOSITIONS.has(f.disposition ?? "")
        ? "delete"
        : "review";
      push(orgRoot(f.orgUnit, functions), {
        id: f.emailId,
        threadId: f.threadId,
        count: f.count,
        category: orgRoot(f.orgUnit, functions),
        from: f.fromName || f.fromEmail || "",
        subject: f.subject || "",
        read: f.line,
        at: f.at ?? "",
        bucket,
      });
    }

    const seen = new Set(
      [...map.values()].flatMap((g) =>
        [...g.review, ...g.delete].map((r) => r.id),
      ),
    );
    for (const theme of brief.digest?.themes ?? []) {
      for (const item of theme.items ?? []) {
        if (seen.has(item.id)) continue;
        seen.add(item.id);
        const category = item.orgUnit
          ? orgRoot(item.orgUnit, functions)
          : theme.theme;
        push(category, {
          id: item.id,
          threadId: item.threadId,
          category,
          from: item.fromName || item.fromEmail || "",
          subject: item.subject || "",
          read: item.line,
          at: item.at ?? "",
          bucket: DELETE_DISPOSITIONS.has(item.disposition ?? "disposable")
            ? "delete"
            : "review",
        });
      }
    }

    return [...map.values()].sort(
      (a, b) =>
        b.review.length + b.delete.length - (a.review.length + a.delete.length),
    );
  }, [brief, functions]);

  const totalRows = groups.reduce(
    (n, g) => n + g.review.length + g.delete.length,
    0,
  );

  if (!brief) {
    return (
      <p className="px-4 py-4 text-[14px] text-[var(--fg)]">
        {building ? "Reading the inbox…" : "Nothing to triage."}
      </p>
    );
  }

  const clearRows = (
    rows: TriageRow[],
    mode: "archive" | "trash",
    reason: string,
  ) =>
    onClear(
      rows.map((r) => ({ id: r.id, threadId: r.threadId, count: r.count })),
      reason,
      mode,
    );

  const Resizer = ({ index }: { index: number }) => (
    <span
      onMouseDown={start(index)}
      className="absolute right-0 top-0 h-full w-1.5 cursor-col-resize select-none hover:bg-[var(--brand)]"
      aria-hidden
    />
  );

  const bucketRows = (rows: TriageRow[], label: string, primary: Bucket) =>
    rows.length === 0 ? null : (
      <>
        <tr className="border-b border-[var(--border)]">
          <td
            colSpan={3}
            className="px-4 py-1 text-[12px] font-bold text-[var(--fg-strong)]"
          >
            {label}
            <span className="ml-1 font-normal">· {rows.length}</span>
          </td>
          <td className="px-2 py-1 text-right text-[12px] font-bold">
            <button
              type="button"
              onClick={() =>
                clearRows(
                  rows,
                  primary === "delete" ? "trash" : "archive",
                  `${label}`,
                )
              }
              className="text-[var(--fg-strong)] hover:underline"
            >
              {primary === "delete" ? "Delete these" : "Archive these"}
            </button>
          </td>
        </tr>
        {rows.map((row) => (
          <tr
            key={row.id}
            className="border-b border-[var(--border)] align-top hover:bg-[var(--row-hover)]"
          >
            <td className="px-4 py-2 text-[14px] text-[var(--fg-strong)]">
              <span className="line-clamp-2">{row.from || "—"}</span>
            </td>
            <td className="px-2 py-2 text-[14px] text-[var(--fg-strong)]">
              <button
                type="button"
                onClick={() => onOpenEmail(row.id)}
                className="block w-full text-left"
              >
                <span className="line-clamp-2">
                  {row.subject || "(no subject)"}
                  {row.count && row.count > 1 ? (
                    <span> · {row.count}</span>
                  ) : null}
                </span>
              </button>
            </td>
            <td className="px-2 py-2 text-[14px] text-[var(--fg)]">
              <span className="line-clamp-2">{row.read}</span>
            </td>
            <td className="whitespace-nowrap px-2 py-2 text-right text-[12px] text-[var(--fg)]">
              {shortTime(row.at)}
            </td>
            <td className="px-4 py-2">
              <div className="flex items-center justify-end gap-1">
                <button
                  type="button"
                  onClick={() => clearRows([row], "archive", "Archive")}
                  aria-label="Archive"
                  title="Archive"
                  className="flex h-8 w-8 items-center justify-center rounded-md text-[var(--fg)] hover:bg-[var(--card)]"
                >
                  <Archive className="h-4 w-4" />
                </button>
                <button
                  type="button"
                  onClick={() => clearRows([row], "trash", "Delete")}
                  aria-label="Delete"
                  title="Delete"
                  className="flex h-8 w-8 items-center justify-center rounded-md text-[var(--fg)] hover:bg-[var(--card)]"
                >
                  <Trash2 className="h-4 w-4" />
                </button>
              </div>
            </td>
          </tr>
        ))}
      </>
    );

  return (
    <div className="min-h-0 flex-1 overflow-auto text-[var(--fg)]">
      <header className="flex items-baseline justify-between gap-3 border-b border-[var(--border)] px-4 py-3">
        <div>
          <h1 className="text-[17px] font-bold text-[var(--fg-strong)]">
            Triage
          </h1>
          <p className="text-[14px] text-[var(--fg)]">
            {totalRows} to clear
            {closing.length ? ` · ${closing.length} to close` : ""}
            {brief.unread ? ` · ${brief.unread} still being read` : ""}
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

      {closing.length > 0 ? (
        <section className="border-b border-[var(--border)] px-4 py-3">
          <h2 className="mb-1 text-[12px] font-bold uppercase tracking-wide text-[var(--fg-strong)]">
            Finished matters
          </h2>
          <ul className="divide-y divide-[var(--border)]">
            {closing.map((m) => (
              <li key={m.id} className="flex items-center gap-3 py-2">
                <div className="min-w-0 flex-1">
                  <span className="block text-[14px] text-[var(--fg-strong)]">
                    {m.title}
                  </span>
                  <span className="block text-[12px] text-[var(--fg)]">
                    {m.statusWhy ?? m.narrative}
                  </span>
                </div>
                <button
                  type="button"
                  onClick={() => onSettle(m.id, true)}
                  className="shrink-0 rounded-full border border-[var(--border)] px-3 py-1 text-[12px] font-bold text-[var(--brand)] hover:bg-[var(--row-hover)]"
                >
                  Close
                </button>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

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
          {groups.map((group) => (
            <tbody key={group.category}>
              <tr className="border-b border-[var(--border)] bg-[var(--card)]">
                <th
                  colSpan={3}
                  className="px-4 py-1.5 text-left text-[12px] font-bold text-[var(--fg-strong)]"
                >
                  {group.category}
                  <span className="ml-1 font-normal">
                    · {group.review.length + group.delete.length}
                  </span>
                </th>
                <td colSpan={2} className="px-4 py-1.5">
                  <div className="flex items-center justify-end gap-3 text-[12px] font-bold">
                    <button
                      type="button"
                      onClick={() =>
                        clearRows(
                          [...group.review, ...group.delete],
                          "archive",
                          `Archive: ${group.category}`,
                        )
                      }
                      className="text-[var(--fg-strong)] hover:underline"
                    >
                      Archive all
                    </button>
                    <button
                      type="button"
                      onClick={() =>
                        clearRows(
                          [...group.review, ...group.delete],
                          "trash",
                          `Delete: ${group.category}`,
                        )
                      }
                      className="text-[var(--fg-strong)] hover:underline"
                    >
                      Delete all
                    </button>
                  </div>
                </td>
              </tr>
              {bucketRows(group.review, "Needs a call · maybe a matter", "review")}
              {bucketRows(group.delete, "Safe to delete", "delete")}
            </tbody>
          ))}
        </table>
      )}
    </div>
  );
}
