"use client";

import type { Guide } from "@/lib/inbox/types";

/** Compact audit of why an email got its action. */
export function LogicExplain({
  guide,
  expanded,
}: {
  guide: Guide;
  expanded?: boolean;
}) {
  const d = guide.debug;
  const sourceLabel =
    guide.source === "gemini"
      ? "Gemini"
      : guide.source === "override"
        ? "Taught"
        : guide.source === "learned"
          ? "Learned from you"
          : guide.source === "rules"
            ? "Rules"
            : null;

  return (
    <div className="mt-1 space-y-1">
      <div
        className="truncate text-[11px] font-semibold"
        style={{ color: guide.color }}
      >
        {guide.label}
        {guide.confidence ? ` · ${guide.confidence}` : ""}
        {sourceLabel ? ` · ${sourceLabel}` : ""}
      </div>
      <div className="line-clamp-2 text-[11px] leading-snug text-[var(--muted)]">
        {guide.reason}
      </div>
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
