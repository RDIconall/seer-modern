"use client";

import { useMemo } from "react";
import type { Brief } from "@/lib/inbox/matters";
import { buildInboxAccounting } from "@/lib/inbox/inbox-accounting";

function asOfLabel(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

/**
 * The one shared accounting view for Atlas and Triage. It renders from the
 * Brief's server-computed accounting object; the fallback only supports
 * cached briefs built before the field existed.
 */
export function InboxDashboard({ brief }: { brief: Brief }) {
  const data = useMemo(
    () =>
      brief.accounting ??
      buildInboxAccounting({
        asOf: brief.builtAt,
        providerTotal:
          brief.providerTotal?.messages ?? brief.totalInbox ?? 0,
        functions: brief.functions ?? [],
        matters: brief.matters,
        pinned: brief.pinned ?? [],
        filed: brief.filed ?? [],
        digestIds: brief.headlineIds.map((row) => row.id),
      }),
    [brief],
  );
  const accounted = data.mapped + data.triage;
  const mappedPercent = data.total
    ? Math.min(100, (data.mapped / data.total) * 100)
    : 0;
  const triagePercent = data.total
    ? Math.min(100 - mappedPercent, (data.triage / data.total) * 100)
    : 0;

  return (
    <section className="border-b border-[var(--border)] px-4 py-3">
      <div className="flex items-baseline justify-between gap-3">
        <h2 className="text-[17px] font-bold text-[var(--fg-strong)]">
          Inbox
        </h2>
        <span className="text-[12px] text-[var(--nav-muted)]">
          {asOfLabel(data.asOf)}
        </span>
      </div>

      <div className="mt-2 grid grid-cols-3 gap-3">
        <div>
          <p className="text-[17px] font-bold text-[var(--fg-strong)]">
            {data.total}
          </p>
          <p className="text-[12px] text-[var(--muted)]">Total</p>
        </div>
        <div>
          <p className="text-[17px] font-bold text-[var(--brand)]">
            {data.mapped}
          </p>
          <p className="text-[12px] text-[var(--muted)]">Atlas</p>
        </div>
        <div>
          <p className="text-[17px] font-bold text-[var(--fg-strong)]">
            {data.triage}
          </p>
          <p className="text-[12px] text-[var(--muted)]">Triage</p>
        </div>
      </div>

      <div
        className="mt-2 flex h-1.5 overflow-hidden rounded-full bg-[var(--border)]"
        aria-label={`${data.mapped} mapped to Atlas, ${data.triage} in Triage`}
      >
        <span
          className="bg-[var(--brand)]"
          style={{ width: `${mappedPercent}%` }}
        />
        <span
          className="bg-[var(--muted)]"
          style={{ width: `${triagePercent}%` }}
        />
      </div>

      {data.mappedByCategory.length > 0 ? (
        <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-[12px]">
          {data.mappedByCategory.map((row) => (
            <span key={row.category} className="text-[var(--muted)]">
              {row.category}{" "}
              <strong className="font-bold text-[var(--fg-strong)]">
                {row.count}
              </strong>
            </span>
          ))}
        </div>
      ) : null}

      <p className="mt-1 text-[12px] text-[var(--nav-muted)]">
        {data.pending > 0
          ? `${accounted} placed · ${data.pending} pending`
          : `${accounted} placed · matches inbox`}
      </p>
    </section>
  );
}
