"use client";

import { Sunrise, X } from "lucide-react";

/**
 * "While you were away" — the first thing you see on open: what
 * arrived, what needs you, distilled from the AI's own task lines.
 */
export function CatchupCard({
  catchup,
  onOpen,
  onDismiss,
}: {
  catchup: {
    since: string;
    newCount: number;
    needsYou: number;
    fyi: number;
    cleared: number;
    headlines: { id: string; who: string; line: string }[];
  };
  onOpen: (id: string) => void;
  onDismiss: () => void;
}) {
  const sinceLabel = new Date(catchup.since).toLocaleString([], {
    weekday: "short",
    hour: "numeric",
    minute: "2-digit",
  });
  return (
    <div className="border-b border-[var(--border)] bg-[var(--brand-soft)] px-4 py-3">
      <div className="flex items-start gap-2.5">
        <Sunrise className="mt-0.5 h-4 w-4 shrink-0 text-[var(--brand)]" />
        <div className="min-w-0 flex-1">
          <p className="text-[13px] font-bold text-[var(--fg-strong)]">
            While you were away{" "}
            <span className="font-normal text-[var(--muted)]">
              (since {sinceLabel})
            </span>
          </p>
          <p className="mt-0.5 text-[12px] text-[var(--fg)]">
            {catchup.newCount} new ·{" "}
            <span className="font-semibold">{catchup.needsYou} need you</span>
            {catchup.fyi > 0 ? ` · ${catchup.fyi} FYI` : ""}
            {catchup.cleared > 0
              ? ` · ${catchup.cleared} ready to clear`
              : ""}
          </p>
          {catchup.headlines.length > 0 ? (
            <ul className="mt-1.5 space-y-1">
              {catchup.headlines.map((h) => (
                <li key={h.id}>
                  <button
                    type="button"
                    onClick={() => onOpen(h.id)}
                    className="w-full truncate text-left text-[12px]"
                  >
                    <span className="font-semibold text-[var(--fg-strong)]">
                      {h.who}
                    </span>{" "}
                    <span className="text-[var(--fg)]">— {h.line}</span>
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
        <button
          type="button"
          onClick={onDismiss}
          aria-label="Dismiss"
          className="shrink-0 rounded-full p-1 text-[var(--muted)] hover:text-[var(--fg)]"
        >
          <X className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
}
