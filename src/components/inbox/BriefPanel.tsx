"use client";

import { CheckCheck, ChevronDown, RefreshCw } from "lucide-react";
import { useMemo, useState } from "react";
import type { Brief, Matter } from "@/lib/inbox/matters";

/** Matters stay the unit — grouping is just a different shelf order. */
type GroupBy = "urgency" | "org" | "relationship";

function groupMatters(
  matters: Matter[],
  by: GroupBy,
): { label: string; matters: Matter[] }[] {
  if (by === "urgency") return [{ label: "", matters }];
  const buckets = new Map<string, Matter[]>();
  for (const m of matters) {
    const key =
      by === "org"
        ? m.orgUnit || "unsorted"
        : m.people?.[0]?.relationship || "no people";
    const list = buckets.get(key) ?? [];
    list.push(m);
    buckets.set(key, list);
  }
  return [...buckets.entries()]
    .map(([label, list]) => ({ label, matters: list }))
    .sort(
      (a, b) =>
        Math.max(...b.matters.map((m) => m.urgency)) -
        Math.max(...a.matters.map((m) => m.urgency)),
    );
}

const OWNER_BADGE: Record<string, { label: string; cls: string }> = {
  you: { label: "YOU", cls: "bg-[#d97706] text-white" },
  team: { label: "TEAM", cls: "bg-[var(--card)] text-[var(--muted)]" },
  them: { label: "WAITING", cls: "bg-[#0e7490] text-white" },
};

/**
 * The state of your work life — matters tracked across days, each line
 * anchored to its emails, plus the headline digest that replaces
 * reading the read-and-delete class one by one.
 */
export function BriefPanel({
  brief,
  building,
  onRebuild,
  onOpen,
  onClearHeadlines,
}: {
  brief: Brief | null;
  building: boolean;
  onRebuild: () => void;
  onOpen: (id: string) => void;
  onClearHeadlines: (ids: { id: string; threadId: string }[]) => void;
}) {
  const [open, setOpen] = useState(true);
  const [showHeadlines, setShowHeadlines] = useState(true);
  const [groupBy, setGroupBy] = useState<GroupBy>("urgency");
  const groups = useMemo(
    () => (brief ? groupMatters(brief.matters, groupBy) : []),
    [brief, groupBy],
  );

  return (
    <div className="border-b border-[var(--border)] bg-[var(--bg)]">
      <div className="flex items-center gap-2 bg-[var(--brand-soft)] px-4 py-2">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
        >
          <ChevronDown
            className={`h-3.5 w-3.5 shrink-0 text-[var(--brand)] transition-transform ${open ? "" : "-rotate-90"}`}
          />
          <span className="text-[11px] font-bold uppercase tracking-wide text-[var(--brand)]">
            The brief
            {brief
              ? ` · ${brief.matters.length} matters`
              : ""}
          </span>
          {brief ? (
            <span className="truncate text-[11px] text-[var(--muted)]">
              updated{" "}
              {new Date(brief.builtAt).toLocaleTimeString([], {
                hour: "numeric",
                minute: "2-digit",
              })}
            </span>
          ) : null}
        </button>
        <button
          type="button"
          disabled={building}
          onClick={onRebuild}
          className="flex shrink-0 items-center gap-1 text-[12px] font-semibold text-[var(--primary)] disabled:opacity-50"
        >
          <RefreshCw className={`h-3.5 w-3.5 ${building ? "animate-spin" : ""}`} />
          {building ? "Reading…" : brief ? "Update" : "Build the brief"}
        </button>
      </div>

      {open && brief ? (
        <div className="px-4 py-2.5">
          <p className="text-[13px] font-medium leading-snug text-[var(--fg-strong)]">
            {brief.summary}
          </p>

          <div className="mt-1.5 flex items-center gap-1">
            <span className="text-[10px] font-semibold uppercase tracking-wide text-[var(--nav-muted)]">
              Group
            </span>
            {(
              [
                ["urgency", "Urgency"],
                ["org", "Org"],
                ["relationship", "Relationship"],
              ] as const
            ).map(([key, label]) => (
              <button
                key={key}
                type="button"
                onClick={() => setGroupBy(key)}
                className={`rounded px-1.5 py-0.5 text-[10px] font-semibold ${
                  groupBy === key
                    ? "bg-[var(--brand)] text-white"
                    : "bg-[var(--card)] text-[var(--muted)]"
                }`}
              >
                {label}
              </button>
            ))}
          </div>

          {groups.map((g) => (
            <div key={g.label || "all"}>
              {g.label ? (
                <p className="mt-2 text-[10px] font-bold uppercase tracking-wide text-[var(--muted)]">
                  {g.label} · {g.matters.length}
                </p>
              ) : null}
              <ul className="mt-2 space-y-2">
                {g.matters.map((m) => (
                  <li key={m.id} className="flex items-start gap-2">
                    <span
                      className={`mt-0.5 shrink-0 rounded px-1.5 py-0.5 text-[9px] font-bold ${OWNER_BADGE[m.owner]?.cls ?? OWNER_BADGE.team.cls}`}
                    >
                      {OWNER_BADGE[m.owner]?.label ?? "TEAM"}
                    </span>
                    <button
                      type="button"
                      onClick={() => m.emailIds[0] && onOpen(m.emailIds[0])}
                      className="min-w-0 flex-1 text-left"
                    >
                      <span className="text-[13px] font-semibold text-[var(--fg-strong)]">
                        {m.title}
                      </span>
                      <span className="text-[12px] text-[var(--fg)]">
                        {" "}
                        — {m.narrative}
                      </span>
                      <span className="mt-0.5 flex flex-wrap items-center gap-1">
                        {m.orgUnit ? (
                          <span
                            className="rounded bg-[var(--card)] px-1 py-0.5 text-[9px] font-bold uppercase tracking-wide text-[var(--muted)]"
                            title={
                              (m.orgConfidence ?? 1) < 0.85
                                ? "Low-confidence assignment — Seer's suggestion, confirm or correct"
                                : undefined
                            }
                          >
                            {m.orgUnit}
                            {(m.orgConfidence ?? 1) < 0.85 ? " ?" : ""}
                          </span>
                        ) : null}
                        {(m.people ?? []).slice(0, 3).map((p) => (
                          <span
                            key={p.name}
                            title={p.relationship}
                            className="rounded bg-[var(--brand-soft)] px-1 py-0.5 text-[9px] font-semibold text-[var(--brand)]"
                          >
                            {p.name.split(" ")[0]}
                            <span className="font-normal text-[var(--muted)]">
                              {" "}
                              · {p.relationship}
                            </span>
                          </span>
                        ))}
                      </span>
                      {m.nextAction && !/^none/i.test(m.nextAction) ? (
                        <span
                          className="block truncate text-[12px] font-semibold"
                          style={{
                            color: m.urgency >= 2 ? "#d97706" : "var(--primary)",
                          }}
                        >
                          → {m.nextAction}
                        </span>
                      ) : null}
                    </button>
                    <span className="shrink-0 text-[10px] text-[var(--nav-muted)]">
                      {m.emailIds.length}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          ))}

          {brief.headlines.length > 0 ? (
            <div className="mt-3 border-t border-[var(--border)] pt-2">
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => setShowHeadlines((v) => !v)}
                  className="flex min-w-0 flex-1 items-center gap-1 text-left text-[10px] font-bold uppercase tracking-wide text-[var(--muted)]"
                >
                  <ChevronDown
                    className={`h-3 w-3 transition-transform ${showHeadlines ? "" : "-rotate-90"}`}
                  />
                  Headlines · {brief.headlines.length} — the glance IS the read
                </button>
                <button
                  type="button"
                  onClick={() => onClearHeadlines(brief.headlineIds)}
                  className="flex shrink-0 items-center gap-1 text-[11px] font-semibold text-[var(--primary)]"
                >
                  <CheckCheck className="h-3.5 w-3.5" />
                  Glanced — clear all
                </button>
              </div>
              {showHeadlines ? (
                <ul className="mt-1 space-y-0.5">
                  {brief.headlines.map((h) => (
                    <li key={h.id}>
                      <button
                        type="button"
                        onClick={() => onOpen(h.id)}
                        className="w-full truncate text-left text-[12px] text-[var(--fg)]"
                      >
                        · {h.line}
                      </button>
                    </li>
                  ))}
                </ul>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : null}
      {open && !brief && !building ? (
        <p className="px-4 py-3 text-[12px] text-[var(--muted)]">
          No brief yet — tap “Build the brief” and Seer will read the whole
          inbox as one unit: the matters you&apos;re tracking, and the
          headlines worth one glance.
        </p>
      ) : null}
    </div>
  );
}
