"use client";

import { ChevronDown, GraduationCap } from "lucide-react";
import { useState } from "react";
import { ACTION_META, type TriageAction } from "@/lib/inbox/classify";
import type { Guide } from "@/lib/inbox/types";

/** The corrections a human actually makes, in one row of chips. */
const TEACH_ACTIONS: TriageAction[] = [
  "respond",
  "act_today",
  "read_and_archive",
  "read_and_delete",
  "delete_now",
  "unsubscribe",
  "glance_promo",
];

export type TeachHandler = (action: TriageAction) => void;

/**
 * "Wrong? Teach Seer" — one tap corrects the sender FOREVER (taught
 * override, top of the precedence chain) and applies the fix to this
 * email right now (unsubscribe actually unsubscribes).
 */
function TeachRow({
  guide,
  onTeach,
}: {
  guide: Guide;
  onTeach: TeachHandler;
}) {
  return (
    <div className="mt-1.5">
      <div className="mb-1 flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wide text-[var(--muted)]">
        <GraduationCap className="h-3 w-3" />
        Wrong? Teach Seer — always:
      </div>
      <div className="flex flex-wrap gap-1">
        {TEACH_ACTIONS.filter((a) => a !== guide.action).map((a) => (
          <button
            key={a}
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onTeach(a);
            }}
            className="rounded px-1.5 py-0.5 text-[10px] font-semibold text-white"
            style={{ backgroundColor: ACTION_META[a].color }}
          >
            {ACTION_META[a].short}
          </button>
        ))}
      </div>
    </div>
  );
}

function sourceLabelFor(guide: Guide): string | null {
  return guide.source === "gemini"
    ? "Gemini"
    : guide.source === "override"
      ? "Taught"
      : guide.source === "learned"
        ? "Learned from you"
        : guide.source === "rules"
          ? "Rules"
          : null;
}

/** Compact audit of why an email got its action. */
export function LogicExplain({
  guide,
  expanded,
  onTeach,
}: {
  guide: Guide;
  expanded?: boolean;
  onTeach?: TeachHandler;
}) {
  const d = guide.debug;
  const sourceLabel = sourceLabelFor(guide);

  return (
    <div className="mt-1 space-y-1">
      <div className="flex min-w-0 items-center gap-1.5">
        {guide.category ? (
          <span className="shrink-0 rounded bg-[var(--card)] px-1.5 py-0.5 text-[10px] font-semibold text-[var(--muted)]">
            {guide.category}
          </span>
        ) : null}
        <span
          className="truncate text-[11px] font-semibold"
          style={{ color: guide.color }}
        >
          {guide.task ?? guide.label}
          {expanded
            ? `${guide.confidence ? ` · ${guide.confidence}` : ""}${sourceLabel ? ` · ${sourceLabel}` : ""}`
            : ""}
        </span>
      </div>
      {expanded ? (
        <div className="line-clamp-2 text-[11px] leading-snug text-[var(--muted)]">
          {guide.reason}
        </div>
      ) : null}
      {expanded && guide.who ? (
        <div className="text-[11px] leading-snug text-[var(--fg)]">
          <span className="font-semibold">Who:</span> {guide.who}
        </div>
      ) : null}
      {expanded && guide.harm ? (
        <div className="text-[11px] leading-snug text-[var(--muted)]">
          <span className="font-semibold">If deleted:</span> {guide.harm}
        </div>
      ) : null}
      {expanded && d ? (
        <dl className="mt-1.5 grid grid-cols-[auto_1fr] gap-x-2 gap-y-0.5 rounded-md bg-[var(--card)] px-2 py-1.5 text-[10px] leading-snug text-[var(--fg)]">
          <dt className="text-[var(--muted)]">Decided by</dt>
          <dd>{sourceLabel ?? "—"}</dd>
          <dt className="text-[var(--muted)]">Rule</dt>
          <dd className="font-mono break-all">{d.ruleId}</dd>
          <dt className="text-[var(--muted)]">Relationship</dt>
          <dd>
            {d.relationship}
            {d.staleEngagement ? " (stale >30d)" : ""}
          </dd>
          <dt className="text-[var(--muted)]">Sent / recv</dt>
          <dd>
            {d.sentTo} sent · {d.receivedFrom} received
            {d.daysSinceLastSent != null
              ? ` · last sent ${Math.round(d.daysSinceLastSent)}d ago`
              : ""}
          </dd>
          <dt className="text-[var(--muted)]">Actionable</dt>
          <dd>{d.actionable ? "yes" : "no"}</dd>
          {d.inContacts != null ? (
            <>
              <dt className="text-[var(--muted)]">Contact</dt>
              <dd>{d.inContacts ? "yes — protected" : "no"}</dd>
            </>
          ) : null}
          {d.meeting ? (
            <>
              <dt className="text-[var(--muted)]">Meeting</dt>
              <dd>{d.meeting}</dd>
            </>
          ) : null}
          <dt className="text-[var(--muted)]">Intel</dt>
          <dd>
            req {d.intel.request} · sched {d.intel.schedule} · notice{" "}
            {d.intel.notices} · follow {d.intel.followUp}
          </dd>
        </dl>
      ) : null}
      {expanded && onTeach ? <TeachRow guide={guide} onTeach={onTeach} /> : null}
    </div>
  );
}

/**
 * Reader guide: one calm line — what to do — with the reasoning tucked
 * behind a "Why?" disclosure so the email is visible immediately.
 */
export function ReaderGuideBar({
  guide,
  onTeach,
}: {
  guide: Guide;
  onTeach?: TeachHandler;
}) {
  const [open, setOpen] = useState(false);
  const d = guide.debug;
  const sourceLabel = sourceLabelFor(guide);

  return (
    <div
      className="mt-3 overflow-hidden rounded-lg"
      style={{
        backgroundColor: `${guide.color}12`,
        border: `1px solid ${guide.color}40`,
      }}
    >
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 px-3 py-2 text-left"
        aria-expanded={open}
      >
        <span
          className="h-2 w-2 shrink-0 rounded-full"
          style={{ backgroundColor: guide.color }}
          aria-hidden
        />
        <span className="min-w-0 flex-1 truncate text-[13px]">
          <span className="font-bold" style={{ color: guide.color }}>
            {guide.task ?? guide.label}
          </span>
          <span className="text-[var(--fg)]"> — {guide.instruction}</span>
        </span>
        <span className="flex shrink-0 items-center gap-1 text-[11px] font-medium text-[var(--muted)]">
          Why?
          <ChevronDown
            className={`h-3.5 w-3.5 transition-transform ${open ? "rotate-180" : ""}`}
          />
        </span>
      </button>
      {open ? (
        <div className="space-y-1.5 border-t border-[var(--border)] px-3 py-2.5">
          <p className="text-[12px] leading-snug text-[var(--fg)]">
            {guide.reason}
            {sourceLabel || guide.confidence ? (
              <span className="text-[var(--muted)]">
                {" "}
                · {[sourceLabel, guide.confidence].filter(Boolean).join(" · ")}
              </span>
            ) : null}
          </p>
          {guide.who ? (
            <p className="text-[12px] leading-snug text-[var(--muted)]">
              <span className="font-semibold text-[var(--fg)]">Who:</span>{" "}
              {guide.who}
            </p>
          ) : null}
          {guide.harm ? (
            <p className="text-[12px] leading-snug text-[var(--muted)]">
              <span className="font-semibold text-[var(--fg)]">
                If deleted:
              </span>{" "}
              {guide.harm}
            </p>
          ) : null}
          {d ? (
            <p className="pt-0.5 font-mono text-[10px] leading-relaxed text-[var(--nav-muted)]">
              {d.ruleId} · {d.relationship}
              {d.staleEngagement ? " (stale)" : ""} · {d.sentTo} sent ·{" "}
              {d.receivedFrom} recv · {d.actionable ? "actionable" : "not actionable"}
              {d.inContacts != null
                ? ` · ${d.inContacts ? "contact" : "not in contacts"}`
                : ""}
              {d.meeting ? ` · ${d.meeting}` : ""}
            </p>
          ) : null}
          {onTeach ? <TeachRow guide={guide} onTeach={onTeach} /> : null}
        </div>
      ) : null}
    </div>
  );
}

export function LogicToggle({
  on,
  onToggle,
  className = "",
}: {
  on: boolean;
  onToggle: () => void;
  className?: string;
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      className={`rounded px-2 py-1 text-[11px] font-semibold ${
        on
          ? "bg-white/20 text-white"
          : "bg-white/10 text-white/90"
      } ${className}`}
      aria-pressed={on}
    >
      {on ? "Logic on" : "Check logic"}
    </button>
  );
}
