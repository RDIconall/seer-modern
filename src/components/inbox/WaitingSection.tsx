"use client";

import { ChevronDown, Hourglass, Loader2, Send } from "lucide-react";
import { useEffect, useState } from "react";

/**
 * The EA's "Waiting On" lane: threads where the user sent the last word
 * to a real person and silence followed. One tap drafts the nudge.
 */

type WaitingItem = {
  threadId: string;
  messageId: string;
  to: string;
  toName: string;
  subject: string;
  sentAt: string;
  daysWaiting: number;
};

export function WaitingSection({
  nudge,
  nudging,
}: {
  nudge: (messageId: string) => void;
  nudging: string | null;
}) {
  const [items, setItems] = useState<WaitingItem[]>([]);
  const [collapsed, setCollapsed] = useState(false);
  const [dismissed, setDismissed] = useState<Set<string>>(new Set());

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const res = await fetch("/api/waiting", { cache: "no-store" });
        const json = await res.json();
        if (alive && res.ok) setItems(json.items ?? []);
      } catch {
        /* section simply doesn't render */
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  const visible = items.filter((i) => !dismissed.has(i.threadId));
  if (visible.length === 0) return null;

  return (
    <section>
      <div className="sticky top-0 z-[1] flex items-center justify-between border-b border-[var(--border)] bg-[var(--brand-soft)] px-4 py-2.5">
        <button
          type="button"
          onClick={() => setCollapsed((c) => !c)}
          className="flex min-w-0 flex-1 items-center gap-1.5 text-left text-[13px] font-semibold text-[#b45309]"
        >
          <Hourglass className="h-3.5 w-3.5" />
          Waiting on · {visible.length}
          <ChevronDown
            className={`h-4 w-4 shrink-0 opacity-60 transition-transform ${collapsed ? "-rotate-90" : ""}`}
          />
        </button>
      </div>
      {!collapsed ? (
        <ul>
          {visible.map((item) => (
            <li
              key={item.threadId}
              className="flex items-center gap-2.5 border-b border-[var(--border)] px-4 py-2.5"
            >
              <div className="min-w-0 flex-1">
                <div className="flex items-baseline gap-1.5">
                  <span className="truncate text-[14px] font-semibold text-[var(--fg-strong)]">
                    {item.toName || item.to}
                  </span>
                  <span className="shrink-0 text-[11px] font-medium text-[#b45309]">
                    {item.daysWaiting}d silent
                  </span>
                </div>
                <div className="truncate text-[12px] text-[var(--muted)]">
                  {item.subject}
                </div>
              </div>
              <button
                type="button"
                disabled={nudging === item.messageId}
                onClick={() => nudge(item.messageId)}
                className="inline-flex shrink-0 items-center gap-1 rounded-full bg-[#b45309] px-3 py-1.5 text-[12px] font-semibold text-white disabled:opacity-50"
              >
                {nudging === item.messageId ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Send className="h-3.5 w-3.5" />
                )}
                Nudge
              </button>
              <button
                type="button"
                onClick={() =>
                  setDismissed((prev) => new Set(prev).add(item.threadId))
                }
                className="shrink-0 rounded-full px-2 py-1.5 text-[12px] text-[var(--muted)]"
              >
                Skip
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}
