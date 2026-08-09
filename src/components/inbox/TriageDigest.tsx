"use client";

import { useMemo, useState } from "react";
import type { Brief, Matter } from "@/lib/inbox/matters";
import { digestThemeRows } from "@/lib/inbox/triage-view";
import { InboxDashboard } from "@/components/inbox/InboxDashboard";

function orgRoot(orgUnit: string, functions: string[]): string {
  const lower = orgUnit.toLowerCase();
  let best = "";
  for (const fn of functions) {
    const fl = fn.toLowerCase();
    if ((lower === fl || lower.startsWith(`${fl} —`)) && fl.length > best.length) {
      best = fn;
    }
  }
  return best || orgUnit;
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
  return new Date(t).toLocaleDateString([], {
    month: "short",
    day: "numeric",
  });
}

/**
 * Triage holds exactly two kinds of thing, and nothing else:
 *
 *   DELETE — the disposable mass, grouped and briefed so a category can go
 *            in one tap without opening a single message.
 *   CLOSE  — matters the evidence says are finished, and the conversations
 *            that are only records now.
 *
 * Anything with live work in it is already a matter in Atlas — the deep read
 * promotes it there itself. Triage never asks "should this be a matter?";
 * that question is the app failing to do its job.
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
  const [open, setOpen] = useState<Set<string>>(new Set());
  const toggle = (key: string) =>
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  const closing = useMemo<Matter[]>(
    () =>
      [...(brief?.pinned ?? []), ...(brief?.matters ?? [])].filter(
        (m) => m.status === "looks-closed",
      ),
    [brief],
  );
  const recordGroups = useMemo(() => {
    const groups = new Map<string, NonNullable<Brief["filed"]>>();
    for (const row of brief?.filed ?? []) {
      const key = orgRoot(row.orgUnit, brief?.functions ?? []);
      groups.set(key, [...(groups.get(key) ?? []), row]);
    }
    return [...groups.entries()]
      .map(([category, rows]) => ({ category, rows }))
      .sort((a, b) => b.rows.length - a.rows.length);
  }, [brief]);

  const themes = brief?.digest?.themes ?? [];
  const deleteCount = themes.reduce((n, t) => n + t.emailIds.length, 0);
  const recordCount = recordGroups.reduce(
    (n, group) =>
      n + group.rows.reduce((sum, row) => sum + (row.count ?? 1), 0),
    0,
  );

  if (!brief) {
    return (
      <p className="px-4 py-4 text-[14px] text-[var(--muted)]">
        {building ? "Reading the inbox…" : "Nothing to triage."}
      </p>
    );
  }

  const nothingLeft =
    themes.length === 0 && recordGroups.length === 0 && closing.length === 0;

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <InboxDashboard brief={brief} />
      <div className="px-4 py-3">
        <header className="mb-3">
          <h1 className="text-[17px] font-bold text-[var(--fg-strong)]">
            Triage
          </h1>
          <p className="text-[14px] text-[var(--muted)]">
            {deleteCount} to delete
            {recordCount || closing.length
              ? ` · ${recordCount + closing.length} to close`
              : ""}
            {brief.unread ? ` · ${brief.unread} still being read` : ""}
          </p>
        </header>

        {nothingLeft ? (
          <p className="text-[14px] text-[var(--muted)]">
            Triage is clear. Everything left in the inbox is a matter.
          </p>
        ) : null}

        {themes.length > 0 ? (
          <section className="mb-6">
            <h2 className="mb-1 text-[17px] font-bold text-[var(--fg-strong)]">
              Delete
            </h2>
            <ul className="divide-y divide-[var(--border)]">
              {themes.map((theme, themeIndex) => {
                const rows = digestThemeRows(theme, brief.headlineIds);
                const key = `delete:${theme.theme}:${themeIndex}`;
                const isOpen = open.has(key);
                const fallbackItems = theme.emailIds
                  .map((id) => brief.headlines.find((h) => h.id === id))
                  .filter(
                    (
                      item,
                    ): item is { id: string; threadId: string; line: string } =>
                      Boolean(item),
                  )
                  .map((item) => ({ ...item, at: "" }));
                const items = theme.items?.length ? theme.items : fallbackItems;
                return (
                  <li key={key} className="py-2">
                    <div className="flex items-start gap-3">
                      <button
                        type="button"
                        onClick={() => toggle(key)}
                        aria-expanded={isOpen}
                        className="min-w-0 flex-1 text-left"
                      >
                        <span className="text-[14px] font-bold text-[var(--fg-strong)]">
                          {theme.theme}
                        </span>
                        <span className="ml-1 text-[12px] text-[var(--nav-muted)]">
                          {theme.emailIds.length}
                        </span>
                        <span className="mt-0.5 block text-[14px] leading-5 text-[var(--muted)]">
                          {theme.line}
                        </span>
                      </button>
                      <button
                        type="button"
                        disabled={rows.length === 0}
                        onClick={() => onClear(rows, theme.theme, "trash")}
                        className="shrink-0 py-0.5 text-[12px] font-bold text-[var(--brand)] disabled:opacity-40"
                      >
                        Delete
                      </button>
                    </div>
                    {isOpen && items.length ? (
                      <ul className="mt-1 border-l border-[var(--border)] pl-3">
                        {items.map((item) => (
                          <li key={item.id}>
                            <button
                              type="button"
                              onClick={() => onOpenEmail(item.id)}
                              className="flex w-full gap-2 py-1 text-left"
                            >
                              <span className="line-clamp-2 min-w-0 flex-1 text-[14px] leading-5 text-[var(--fg)]">
                                {item.line}
                              </span>
                              <span className="shrink-0 text-[12px] text-[var(--nav-muted)]">
                                {shortTime(item.at)}
                              </span>
                            </button>
                          </li>
                        ))}
                      </ul>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          </section>
        ) : null}

        {closing.length > 0 || recordGroups.length > 0 ? (
          <section>
            <h2 className="mb-1 text-[17px] font-bold text-[var(--fg-strong)]">
              Close out
            </h2>
            <ul className="divide-y divide-[var(--border)]">
              {closing.map((matter) => (
                <li key={matter.id} className="py-2">
                  <div className="flex items-start gap-3">
                    <div className="min-w-0 flex-1">
                      <span className="block text-[14px] font-bold text-[var(--fg-strong)]">
                        {matter.title}
                      </span>
                      <span className="mt-0.5 block text-[14px] leading-5 text-[var(--muted)]">
                        {matter.statusWhy ?? matter.narrative}
                      </span>
                    </div>
                    <button
                      type="button"
                      onClick={() => onSettle(matter.id, true)}
                      className="shrink-0 py-0.5 text-[12px] font-bold text-[var(--brand)]"
                    >
                      Close
                    </button>
                  </div>
                </li>
              ))}

              {recordGroups.map((group) => {
                const key = `records:${group.category}`;
                const isOpen = open.has(key);
                const messageCount = group.rows.reduce(
                  (n, row) => n + (row.count ?? 1),
                  0,
                );
                const rows = group.rows.map((row) => ({
                  id: row.emailId,
                  threadId: row.threadId,
                  count: row.count,
                }));
                return (
                  <li key={key} className="py-2">
                    <div className="flex items-start gap-3">
                      <button
                        type="button"
                        onClick={() => toggle(key)}
                        aria-expanded={isOpen}
                        className="min-w-0 flex-1 text-left"
                      >
                        <span className="text-[14px] font-bold text-[var(--fg-strong)]">
                          {group.category}
                        </span>
                        <span className="ml-1 text-[12px] text-[var(--nav-muted)]">
                          {messageCount}
                        </span>
                        <span className="mt-0.5 block text-[14px] leading-5 text-[var(--muted)]">
                          Records with nothing left to do.
                        </span>
                      </button>
                      <button
                        type="button"
                        onClick={() =>
                          onClear(rows, `Close: ${group.category}`, "archive")
                        }
                        className="shrink-0 py-0.5 text-[12px] font-bold text-[var(--brand)]"
                      >
                        Close
                      </button>
                    </div>
                    {isOpen ? (
                      <ul className="mt-1 border-l border-[var(--border)] pl-3">
                        {group.rows.map((row) => (
                          <li key={row.emailId}>
                            <button
                              type="button"
                              onClick={() => onOpenEmail(row.emailId)}
                              className="flex w-full gap-2 py-1 text-left"
                            >
                              <span className="line-clamp-2 min-w-0 flex-1 text-[14px] leading-5 text-[var(--fg)]">
                                {row.line}
                              </span>
                              <span className="shrink-0 text-[12px] text-[var(--nav-muted)]">
                                {shortTime(row.at)}
                              </span>
                            </button>
                          </li>
                        ))}
                      </ul>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          </section>
        ) : null}
      </div>
    </div>
  );
}
