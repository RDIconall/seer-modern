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
  return best || orgUnit || "—";
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
  category: string;
  summary: string;
  at: string;
  /** The verb the deep read leans toward — sets which action is primary. */
  lean: "delete" | "archive";
};

/**
 * TRIAGE, AS A TABLE.
 *
 * Every conversation the app did not make a matter, one row, with its own
 * Archive and Delete. No accordions, no bulk-only buttons: the CEO asked to
 * see the list and act on any single line. "Delete" trashes, "Archive"
 * files it away; both are optimistic and undoable.
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

  const rows = useMemo<TriageRow[]>(() => {
    if (!brief) return [];
    const out: TriageRow[] = [];
    // Records — mail with no live work, leaning to Archive (keep as record).
    for (const f of brief.filed ?? []) {
      out.push({
        id: f.emailId,
        threadId: f.threadId,
        count: f.count,
        category: orgRoot(f.orgUnit, functions),
        summary: f.line,
        at: f.at ?? "",
        lean: "archive",
      });
    }
    // Disposable / FYI mass — leaning to Delete.
    const seen = new Set(out.map((r) => r.id));
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
              };
            });
      for (const item of items) {
        if (seen.has(item.id)) continue;
        seen.add(item.id);
        out.push({
          id: item.id,
          threadId: item.threadId,
          category: theme.theme,
          summary: item.line || theme.line,
          at: item.at ?? "",
          lean: "delete",
        });
      }
    }
    return out.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
  }, [brief, functions]);

  if (!brief) {
    return (
      <p className="px-4 py-4 text-[14px] text-[var(--muted)]">
        {building ? "Reading the inbox…" : "Nothing to triage."}
      </p>
    );
  }

  const clearOne = (row: TriageRow, mode: "archive" | "trash") =>
    onClear(
      [{ id: row.id, threadId: row.threadId, count: row.count }],
      mode === "trash" ? "Delete" : "Archive",
      mode,
    );

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <header className="flex items-baseline justify-between gap-3 border-b border-[var(--border)] px-4 py-3">
        <div>
          <h1 className="text-[17px] font-bold text-[var(--fg-strong)]">
            Triage
          </h1>
          <p className="text-[14px] text-[var(--muted)]">
            {rows.length} to clear
            {closing.length ? ` · ${closing.length} to close` : ""}
            {brief.unread ? ` · ${brief.unread} still being read` : ""}
          </p>
        </div>
        <a
          href="/api/export/inbox"
          className="flex shrink-0 items-center gap-1 text-[12px] text-[var(--muted)] hover:text-[var(--fg)]"
        >
          <Download className="h-4 w-4" />
          Export
        </a>
      </header>

      {closing.length > 0 ? (
        <section className="border-b border-[var(--border)] px-4 py-3">
          <h2 className="mb-1 text-[12px] font-bold uppercase tracking-wide text-[var(--nav-muted)]">
            Finished matters
          </h2>
          <ul className="divide-y divide-[var(--border)]">
            {closing.map((m) => (
              <li key={m.id} className="flex items-center gap-3 py-2">
                <div className="min-w-0 flex-1">
                  <span className="block text-[14px] text-[var(--fg-strong)]">
                    {m.title}
                  </span>
                  <span className="block text-[12px] text-[var(--muted)]">
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

      {rows.length === 0 ? (
        <p className="px-4 py-6 text-[14px] text-[var(--muted)]">
          Nothing to clear. Everything left in the inbox is a matter.
        </p>
      ) : (
        <table className="w-full border-collapse text-left">
          <thead>
            <tr className="border-b border-[var(--border)] text-[12px] text-[var(--nav-muted)]">
              <th className="px-4 py-2 font-normal">Category</th>
              <th className="px-2 py-2 font-normal">What it is</th>
              <th className="px-2 py-2 font-normal text-right">When</th>
              <th className="px-4 py-2 font-normal text-right">Actions</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr
                key={row.id}
                className="border-b border-[var(--border)] align-top hover:bg-[var(--row-hover)]"
              >
                <td className="px-4 py-2 text-[12px] text-[var(--nav-muted)]">
                  <span className="line-clamp-2">{row.category}</span>
                </td>
                <td className="px-2 py-2">
                  <button
                    type="button"
                    onClick={() => onOpenEmail(row.id)}
                    className="block w-full text-left text-[14px] leading-5 text-[var(--fg)]"
                  >
                    <span className="line-clamp-2">
                      {row.summary}
                      {row.count && row.count > 1 ? (
                        <span className="text-[var(--nav-muted)]">
                          {" "}
                          · {row.count}
                        </span>
                      ) : null}
                    </span>
                  </button>
                </td>
                <td className="whitespace-nowrap px-2 py-2 text-right text-[12px] text-[var(--nav-muted)]">
                  {shortTime(row.at)}
                </td>
                <td className="px-4 py-2">
                  <div className="flex items-center justify-end gap-1">
                    <button
                      type="button"
                      onClick={() => clearOne(row, "archive")}
                      aria-label="Archive"
                      title="Archive"
                      className={`flex h-8 w-8 items-center justify-center rounded-md hover:bg-[var(--card)] ${
                        row.lean === "archive"
                          ? "text-[var(--brand)]"
                          : "text-[var(--muted)]"
                      }`}
                    >
                      <Archive className="h-4 w-4" />
                    </button>
                    <button
                      type="button"
                      onClick={() => clearOne(row, "trash")}
                      aria-label="Delete"
                      title="Delete"
                      className={`flex h-8 w-8 items-center justify-center rounded-md hover:bg-[var(--card)] ${
                        row.lean === "delete"
                          ? "text-[var(--accent)]"
                          : "text-[var(--muted)]"
                      }`}
                    >
                      <Trash2 className="h-4 w-4" />
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
