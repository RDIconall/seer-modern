"use client";

import { useMemo, useState } from "react";
import type { Brief } from "@/lib/inbox/matters";
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
 * Triage is the briefing for everything that is not currently a matter.
 *
 * It consumes the SAME Brief as Atlas:
 * - deep-read matter disagreements become one-click promotion candidates;
 * - the disposable/FYI mass is grouped in the user's business vocabulary,
 *   with one sentence containing the facts worth knowing and one clear
 *   action per category.
 *
 * No old guide.action buckets, no competing classifier, no "Clear · 235".
 */
export function TriageDigest({
  brief,
  building,
  onOpenEmail,
  onCreateMatter,
  onClear,
}: {
  brief: Brief | null;
  building: boolean;
  onOpenEmail: (id: string) => void;
  onCreateMatter: (
    title: string,
    emailIds: string[],
    orgUnit?: string,
  ) => void;
  onClear: (
    rows: { id: string; threadId: string; count?: number }[],
    reason?: string,
  ) => void;
}) {
  const [openThemes, setOpenThemes] = useState<Set<string>>(new Set());
  const candidates = useMemo(
    () => (brief?.filed ?? []).filter((f) => f.matterCandidate),
    [brief],
  );
  const recordGroups = useMemo(() => {
    const groups = new Map<string, NonNullable<Brief["filed"]>>();
    for (const row of brief?.filed ?? []) {
      if (row.matterCandidate) continue;
      const key = orgRoot(row.orgUnit, brief?.functions ?? []);
      groups.set(key, [...(groups.get(key) ?? []), row]);
    }
    return [...groups.entries()]
      .map(([category, rows]) => ({ category, rows }))
      .sort((a, b) => b.rows.length - a.rows.length);
  }, [brief]);
  const themes = brief?.digest?.themes ?? [];
  const digestCount = themes.reduce((n, t) => n + t.emailIds.length, 0);
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

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <InboxDashboard brief={brief} />
      <div className="px-4 py-3">
      <header className="mb-3">
        <h1 className="text-[17px] font-bold text-[var(--fg-strong)]">
          Triage
        </h1>
        <p className="text-[14px] text-[var(--muted)]">
          {candidates.length
            ? `${candidates.length} possible matter${candidates.length === 1 ? "" : "s"} · `
            : ""}
          {recordCount ? `${recordCount} records · ` : ""}
          {digestCount} updates summarized
          {brief.unread ? ` · ${brief.unread} still being read` : ""}
        </p>
      </header>

      {candidates.length > 0 ? (
        <section className="mb-5">
          <h2 className="mb-1 text-[17px] font-bold text-[var(--fg-strong)]">
            Possible matters
          </h2>
          <ul className="divide-y divide-[var(--border)]">
            {candidates.map((row) => {
              const candidate = row.matterCandidate!;
              return (
                <li key={row.emailId} className="py-2">
                  <button
                    type="button"
                    onClick={() => onOpenEmail(row.emailId)}
                    className="block w-full text-left"
                  >
                    <span className="block text-[14px] font-bold text-[var(--fg-strong)]">
                      {candidate.title}
                    </span>
                    <span className="mt-0.5 block text-[14px] leading-5 text-[var(--muted)]">
                      {candidate.why}
                    </span>
                  </button>
                  <div className="mt-1 flex items-center gap-3 text-[12px]">
                    <span className="text-[var(--nav-muted)]">
                      {candidate.orgUnit}
                    </span>
                    <button
                      type="button"
                      onClick={() =>
                        onCreateMatter(
                          candidate.title,
                          candidate.emailIds,
                          candidate.orgUnit,
                        )
                      }
                      className="font-bold text-[var(--brand)]"
                    >
                      Make matter
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
        </section>
      ) : null}

      {recordGroups.length > 0 ? (
        <section className="mb-5">
          <h2 className="mb-1 text-[17px] font-bold text-[var(--fg-strong)]">
            Records to file
          </h2>
          <ul className="divide-y divide-[var(--border)]">
            {recordGroups.map((group) => {
              const key = `records:${group.category}`;
              const open = openThemes.has(key);
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
                      onClick={() =>
                        setOpenThemes((prev) => {
                          const next = new Set(prev);
                          if (next.has(key)) next.delete(key);
                          else next.add(key);
                          return next;
                        })
                      }
                      aria-expanded={open}
                      className="min-w-0 flex-1 text-left"
                    >
                      <span className="text-[14px] font-bold text-[var(--fg-strong)]">
                        {group.category}
                      </span>
                      <span className="ml-1 text-[12px] text-[var(--nav-muted)]">
                        {group.rows.length}
                      </span>
                    </button>
                    <button
                      type="button"
                      onClick={() => onClear(rows, `File: ${group.category}`)}
                      className="shrink-0 py-0.5 text-[12px] font-bold text-[var(--brand)]"
                    >
                      File
                    </button>
                  </div>
                  {open ? (
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

      <section>
        <h2 className="mb-1 text-[17px] font-bold text-[var(--fg-strong)]">
          What else happened
        </h2>
        {themes.length === 0 ? (
          <p className="text-[14px] text-[var(--muted)]">
            Nothing else needs a look.
          </p>
        ) : (
          <ul className="divide-y divide-[var(--border)]">
            {themes.map((theme, themeIndex) => {
              const rows = digestThemeRows(theme, brief.headlineIds);
              const open = openThemes.has(theme.theme);
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
                <li key={`${theme.theme}:${themeIndex}`} className="py-2">
                  <div className="flex items-start gap-3">
                    <button
                      type="button"
                      onClick={() =>
                        setOpenThemes((prev) => {
                          const next = new Set(prev);
                          if (next.has(theme.theme)) next.delete(theme.theme);
                          else next.add(theme.theme);
                          return next;
                        })
                      }
                      aria-expanded={open}
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
                      onClick={() => onClear(rows, theme.theme)}
                      className="shrink-0 py-0.5 text-[12px] font-bold text-[var(--brand)] disabled:opacity-40"
                    >
                      Clear
                    </button>
                  </div>
                  {open && items.length ? (
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
        )}
      </section>
      </div>
    </div>
  );
}
