"use client";

import { useMemo } from "react";
import { Archive, Download, Trash2 } from "lucide-react";
import type { Brief, Matter } from "@/lib/inbox/matters";

function orgRoot(orgUnit: string, functions: string[]): string {
  const lower = orgUnit.toLowerCase();
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

type TriageRow = {
  id: string;
  threadId: string;
  count?: number;
  from: string;
  subject: string;
  summary: string;
  at: string;
  lean: "delete" | "archive";
};

type TriageGroup = {
  category: string;
  lean: "delete" | "archive";
  rows: TriageRow[];
};

/**
 * TRIAGE, AS A TABLE (issues #15, #16).
 *
 * Rows are grouped by category, each group has bulk Archive/Delete over the
 * whole category, and every row also has its own Archive and Delete. There is
 * no grey text anywhere — a table is only readable when every cell reads at
 * the same strength, so all of it is the foreground colour. Delete trashes,
 * Archive files away; both are optimistic and undoable.
 *
 * Finished matters (the deep read says the work is done) sit above the table
 * as one-tap Close rows, because a matter is a different object from a mail.
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
    const add = (category: string, lean: "delete" | "archive", row: TriageRow) => {
      const g = map.get(category) ?? { category, lean, rows: [] };
      g.rows.push(row);
      map.set(category, g);
    };
    // Records — mail with no live work, leaning to Archive (keep as record).
    for (const f of brief.filed ?? []) {
      const category = orgRoot(f.orgUnit, functions);
      add(category, "archive", {
        id: f.emailId,
        threadId: f.threadId,
        count: f.count,
        from: f.fromName || f.line.split(" — ")[0] || "",
        subject: f.subject || f.line,
        summary: f.line,
        at: f.at ?? "",
        lean: "archive",
      });
    }
    // Disposable / FYI mass — grouped by the digest's own themes, lean Delete.
    const seen = new Set([...map.values()].flatMap((g) => g.rows.map((r) => r.id)));
    for (const theme of brief.digest?.themes ?? []) {
      const items =
        theme.items?.length
          ? theme.items
          : theme.emailIds.map((id) => {
              const h = brief.headlines.find((x) => x.id === id);
              return {
                id,
                threadId: h?.threadId ?? "",
                line: h?.line ?? theme.line,
                at: "",
                fromName: "",
                subject: "",
              };
            });
      for (const item of items) {
        if (seen.has(item.id)) continue;
        seen.add(item.id);
        add(theme.theme, "delete", {
          id: item.id,
          threadId: item.threadId,
          from: item.fromName || "",
          subject: item.subject || item.line || theme.line,
          summary: item.line || theme.line,
          at: item.at ?? "",
          lean: "delete",
        });
      }
    }
    return [...map.values()].sort((a, b) => b.rows.length - a.rows.length);
  }, [brief, functions]);

  const totalRows = groups.reduce((n, g) => n + g.rows.length, 0);

  if (!brief) {
    return (
      <p className="px-4 py-4 text-[14px] text-[var(--fg)]">
        {building ? "Reading the inbox…" : "Nothing to triage."}
      </p>
    );
  }

  const clearRows = (rows: TriageRow[], mode: "archive" | "trash", reason: string) =>
    onClear(
      rows.map((r) => ({ id: r.id, threadId: r.threadId, count: r.count })),
      reason,
      mode,
    );

  return (
    <div className="min-h-0 flex-1 overflow-y-auto text-[var(--fg)]">
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
        <table className="w-full border-collapse text-left text-[var(--fg)]">
          <thead>
            <tr className="border-b border-[var(--border)] text-[12px] font-bold text-[var(--fg-strong)]">
              <th className="px-4 py-2">From</th>
              <th className="px-2 py-2">Subject</th>
              <th className="px-2 py-2 text-right">When</th>
              <th className="px-4 py-2 text-right">Actions</th>
            </tr>
          </thead>
          {groups.map((group) => (
            <tbody key={group.category}>
              {/* Category header: name, count, and a bulk action over the
                  whole group — the "move by category" the CEO asked for. */}
              <tr className="border-b border-[var(--border)] bg-[var(--card)]">
                <th
                  colSpan={3}
                  className="px-4 py-1.5 text-left text-[12px] font-bold text-[var(--fg-strong)]"
                >
                  {group.category}
                  <span className="ml-1 font-normal">· {group.rows.length}</span>
                </th>
                <td className="px-4 py-1.5">
                  <div className="flex items-center justify-end gap-2 text-[12px] font-bold">
                    <button
                      type="button"
                      onClick={() =>
                        clearRows(group.rows, "archive", `Archive: ${group.category}`)
                      }
                      className="text-[var(--fg-strong)] hover:underline"
                    >
                      Archive all
                    </button>
                    <button
                      type="button"
                      onClick={() =>
                        clearRows(group.rows, "trash", `Delete: ${group.category}`)
                      }
                      className="text-[var(--fg-strong)] hover:underline"
                    >
                      Delete all
                    </button>
                  </div>
                </td>
              </tr>
              {group.rows.map((row) => (
                <tr
                  key={row.id}
                  className="border-b border-[var(--border)] align-top hover:bg-[var(--row-hover)]"
                >
                  <td className="whitespace-nowrap px-4 py-2 text-[14px] text-[var(--fg-strong)]">
                    <span className="line-clamp-2">{row.from || "—"}</span>
                  </td>
                  <td className="px-2 py-2">
                    <button
                      type="button"
                      onClick={() => onOpenEmail(row.id)}
                      className="block w-full text-left text-[14px] leading-5 text-[var(--fg)]"
                    >
                      <span className="line-clamp-2">
                        {row.subject}
                        {row.count && row.count > 1 ? (
                          <span> · {row.count}</span>
                        ) : null}
                      </span>
                    </button>
                  </td>
                  <td className="whitespace-nowrap px-2 py-2 text-right text-[12px] text-[var(--fg)]">
                    {shortTime(row.at)}
                  </td>
                  <td className="px-4 py-2">
                    <div className="flex items-center justify-end gap-1">
                      <button
                        type="button"
                        onClick={() =>
                          clearRows([row], "archive", "Archive")
                        }
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
            </tbody>
          ))}
        </table>
      )}
    </div>
  );
}
