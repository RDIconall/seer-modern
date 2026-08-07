"use client";

import { CheckCheck, ChevronDown, RefreshCw } from "lucide-react";
import { useState } from "react";
import type { Brief } from "@/lib/inbox/matters";

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

          <ul className="mt-2 space-y-2">
            {brief.matters.map((m) => (
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
