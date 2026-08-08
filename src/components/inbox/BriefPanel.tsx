"use client";

import { ChevronDown, ChevronRight } from "lucide-react";
import { useMemo, useState } from "react";
import type { Brief, Matter } from "@/lib/inbox/matters";

/**
 * THE BRIEF as a Checkvist-style outline: plain text, one line per
 * matter, disclosure on demand. Typography and indentation carry the
 * structure; the single accent marks what is YOURS. No badges.
 */

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

/** you = solid marker in the one accent; them/team = quiet glyphs */
function ownerGlyph(owner: string): { glyph: string; cls: string } {
  if (owner === "you") return { glyph: "●", cls: "text-[var(--brand)]" };
  if (owner === "them") return { glyph: "◌", cls: "text-[var(--muted)]" };
  return { glyph: "–", cls: "text-[var(--nav-muted)]" };
}

function MatterLine({
  m,
  onOpen,
  full,
}: {
  m: Matter;
  onOpen: (id: string) => void;
  full?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const g = ownerGlyph(m.owner);
  const lowConf = (m.orgConfidence ?? 1) < 0.85;
  return (
    <li>
      <div className="group flex items-baseline gap-1.5">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-label={open ? "Collapse" : "Expand"}
          className="w-4 shrink-0 text-[var(--nav-muted)]"
        >
          {open ? (
            <ChevronDown className="h-3.5 w-3.5" />
          ) : (
            <ChevronRight className="h-3.5 w-3.5" />
          )}
        </button>
        <span className={`shrink-0 text-[11px] ${g.cls}`} title={m.owner}>
          {g.glyph}
        </span>
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className={`min-w-0 flex-1 truncate text-left ${full ? "text-[15px] leading-8" : "text-[13px] leading-6"}`}
        >
          <span className="font-semibold text-[var(--fg-strong)]">
            {m.title}
          </span>
          <span className="text-[var(--muted)]"> — {m.narrative}</span>
        </button>
      </div>
      {open ? (
        <div className={`ml-10 space-y-0.5 pb-1.5 ${full ? "text-[13px] leading-6" : "text-[12px] leading-5"}`}>
          {m.nextAction && !/^none/i.test(m.nextAction) ? (
            <p className="text-[var(--fg)]">→ {m.nextAction}</p>
          ) : null}
          <p className="text-[var(--muted)]">
            {m.orgUnit}
            {lowConf ? "?" : ""}
            {m.people?.length
              ? ` · ${m.people
                  .slice(0, 4)
                  .map((p) => `${p.name.split(" ")[0]} (${p.relationship})`)
                  .join(", ")}`
              : ""}
            {" · "}
            <button
              type="button"
              onClick={() => m.emailIds[0] && onOpen(m.emailIds[0])}
              className="underline decoration-[var(--border)] underline-offset-2 hover:text-[var(--fg)]"
            >
              {m.emailIds.length} email{m.emailIds.length === 1 ? "" : "s"}
            </button>
          </p>
        </div>
      ) : null}
    </li>
  );
}

export function BriefPanel({
  brief,
  building,
  onRebuild,
  onOpen,
  onClearHeadlines,
  full,
}: {
  brief: Brief | null;
  building: boolean;
  onRebuild: () => void;
  onOpen: (id: string) => void;
  onClearHeadlines: (ids: { id: string; threadId: string }[]) => void;
  /** Atlas mode: full-page scale, always expanded */
  full?: boolean;
}) {
  const [open, setOpen] = useState(true);
  const [showHeadlines, setShowHeadlines] = useState(Boolean(full));
  const [groupBy, setGroupBy] = useState<GroupBy>("urgency");
  const groups = useMemo(
    () => (brief ? groupMatters(brief.matters, groupBy) : []),
    [brief, groupBy],
  );

  return (
    <div className="border-b border-[var(--border)]">
      {/* header: one quiet line */}
      <div className="flex items-baseline gap-2 px-4 pt-2.5">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="flex min-w-0 items-baseline gap-1.5 text-left"
        >
          <span className="text-[11px] font-bold uppercase tracking-widest text-[var(--fg-strong)]">
            Brief
          </span>
          {brief ? (
            <span className="text-[11px] text-[var(--nav-muted)]">
              {brief.matters.length} matters ·{" "}
              {new Date(brief.builtAt).toLocaleTimeString([], {
                hour: "numeric",
                minute: "2-digit",
              })}
            </span>
          ) : null}
        </button>
        <span className="flex-1" />
        {brief ? (
          <span className="flex items-baseline gap-2 text-[11px] text-[var(--nav-muted)]">
            {(
              [
                ["urgency", "urgency"],
                ["org", "org"],
                ["relationship", "people"],
              ] as const
            ).map(([key, label]) => (
              <button
                key={key}
                type="button"
                onClick={() => setGroupBy(key)}
                className={
                  groupBy === key
                    ? "text-[var(--fg-strong)] underline underline-offset-4"
                    : "hover:text-[var(--fg)]"
                }
              >
                {label}
              </button>
            ))}
          </span>
        ) : null}
        <button
          type="button"
          disabled={building}
          onClick={onRebuild}
          className="text-[11px] text-[var(--nav-muted)] hover:text-[var(--fg)] disabled:opacity-50"
        >
          {building ? "reading…" : "update"}
        </button>
      </div>

      {open && brief ? (
        <div className="px-4 pb-2.5 pt-1.5">
          <p className={`mb-1.5 max-w-[70ch] text-[var(--muted)] ${full ? "text-[14px] leading-6" : "line-clamp-2 text-[12px] leading-5"}`}>
            {brief.summary}
          </p>

          {groups.map((g) => (
            <div key={g.label || "all"}>
              {g.label ? (
                <p className="mt-2 text-[10px] font-semibold uppercase tracking-widest text-[var(--nav-muted)]">
                  {g.label} · {g.matters.length}
                </p>
              ) : null}
              <ul>
                {g.matters.map((m) => (
                  <MatterLine key={m.id} m={m} onOpen={onOpen} full={full} />
                ))}
              </ul>
            </div>
          ))}

          {brief.headlines.length > 0 ? (
            <div className="mt-1.5 flex items-baseline gap-2 text-[12px]">
              <button
                type="button"
                onClick={() => setShowHeadlines((v) => !v)}
                className="text-[var(--nav-muted)] hover:text-[var(--fg)]"
              >
                {showHeadlines ? "▾" : "▸"} {brief.headlines.length} headlines
              </button>
              <button
                type="button"
                onClick={() => onClearHeadlines(brief.headlineIds)}
                className="text-[var(--nav-muted)] underline decoration-[var(--border)] underline-offset-2 hover:text-[var(--fg)]"
              >
                glanced — clear all
              </button>
            </div>
          ) : null}
          {showHeadlines && brief.headlines.length > 0 ? (
            <ul className="ml-4 mt-0.5">
              {brief.headlines.map((h) => (
                <li key={h.id}>
                  <button
                    type="button"
                    onClick={() => onOpen(h.id)}
                    className="w-full truncate text-left text-[12px] leading-5 text-[var(--muted)] hover:text-[var(--fg)]"
                  >
                    · {h.line}
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
      {open && !brief && !building ? (
        <p className="px-4 pb-3 text-[12px] text-[var(--muted)]">
          No brief yet — “update” reads the inbox as one unit.
        </p>
      ) : null}
    </div>
  );
}
