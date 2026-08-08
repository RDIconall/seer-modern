"use client";

import {
  BellOff,
  Check,
  Loader2,
  Smartphone,
  Sparkles,
  X,
} from "lucide-react";
import { useEffect, useState } from "react";

/**
 * The aggressive unsubscribe agent: AI reviews every bulk sender in the
 * inbox, flags what to cut — including emails that duplicate the push
 * notifications the user's phone already shows — and executes real
 * unsubscribes (one-click / mailto / link) plus sender mutes in bulk.
 */

type Suggestion = {
  fromEmail: string;
  fromName: string;
  count: number;
  lastAt: string;
  latestId: string;
  phoneDup: boolean;
  reason: string;
};

export function UnsubAgentSheet({
  onClose,
  onDone,
}: {
  onClose: () => void;
  onDone?: (summary: string) => void;
}) {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [scanned, setScanned] = useState(0);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [running, setRunning] = useState(false);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const res = await fetch("/api/unsub-agent", { cache: "no-store" });
        const json = await res.json();
        if (!res.ok) throw new Error(json.error ?? "Agent failed");
        if (!alive) return;
        setSuggestions(json.suggestions ?? []);
        setScanned(json.scanned ?? 0);
        setPicked(
          new Set(
            (json.suggestions ?? []).map((s: Suggestion) => s.fromEmail),
          ),
        );
      } catch (e) {
        if (alive) setError(e instanceof Error ? e.message : "Agent failed");
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  const toggle = (email: string) => {
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(email)) next.delete(email);
      else next.add(email);
      return next;
    });
  };

  const execute = async () => {
    const chosen = suggestions.filter((s) => picked.has(s.fromEmail));
    if (chosen.length === 0 || running) return;
    setRunning(true);
    setError(null);
    try {
      const res = await fetch("/api/unsubscribe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          items: chosen.map((s) => ({
            id: s.latestId,
            fromEmail: s.fromEmail,
          })),
        }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "Unsubscribe failed");
      onDone?.(
        `Cut ${chosen.length} senders — ${json.unsubscribed ?? 0} unsubscribed for real, all muted`,
      );
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Unsubscribe failed");
      setRunning(false);
    }
  };

  const phoneDups = suggestions.filter((s) => s.phoneDup);
  const rest = suggestions.filter((s) => !s.phoneDup);

  const row = (s: Suggestion) => (
    <li key={s.fromEmail} className="border-b border-[var(--border)]">
      <button
        type="button"
        onClick={() => toggle(s.fromEmail)}
        className="flex w-full items-start gap-2.5 px-4 py-2.5 text-left"
      >
        <span
          aria-hidden
          className={`mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full border-2 ${
            picked.has(s.fromEmail)
              ? "border-[#a855f7] bg-[#a855f7] text-white"
              : "border-[var(--border)]"
          }`}
        >
          {picked.has(s.fromEmail) ? <Check className="h-3 w-3" /> : null}
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex items-baseline gap-1.5">
            <span className="truncate text-[14px] font-semibold">
              {s.fromName || s.fromEmail}
            </span>
            <span className="shrink-0 text-[11px] text-[var(--muted)]">
              · {s.count} in inbox
            </span>
          </span>
          <span className="block text-[12px] leading-snug text-[var(--muted)]">
            {s.reason}
          </span>
        </span>
        {s.phoneDup ? (
          <Smartphone className="mt-0.5 h-4 w-4 shrink-0 text-[var(--primary)]" />
        ) : null}
      </button>
    </li>
  );

  return (
    <div className="fixed inset-0 z-[60] flex items-end justify-center bg-black/40 sm:items-center">
      <button
        type="button"
        aria-label="Close"
        className="absolute inset-0"
        onClick={onClose}
      />
      <div className="relative flex max-h-[85dvh] w-full max-w-md flex-col rounded-t-2xl bg-[var(--bg)] shadow-2xl sm:rounded-2xl">
        <div className="flex items-center justify-between px-5 pb-1 pt-4">
          <h2 className="flex items-center gap-2 text-[16px] font-semibold">
            <BellOff className="h-4 w-4 text-[#a855f7]" />
            Unsubscribe agent
          </h2>
          <button
            type="button"
            onClick={onClose}
            className="rounded-full p-1.5 text-[var(--muted)] hover:bg-[var(--card)]"
            aria-label="Close"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {loading ? (
          <div className="flex flex-col items-center gap-2 px-5 py-12 text-sm text-[var(--muted)]">
            <Loader2 className="h-5 w-5 animate-spin text-[#a855f7]" />
            <span className="flex items-center gap-1">
              <Sparkles className="h-3.5 w-3.5" />
              Reading your senders…
            </span>
          </div>
        ) : error ? (
          <p className="mx-5 my-6 rounded-lg bg-red-500/10 px-3 py-2 text-sm text-red-600">
            {error}
          </p>
        ) : suggestions.length === 0 ? (
          <p className="px-5 py-10 text-center text-sm text-[var(--muted)]">
            Nothing to cut — your {scanned} senders all look load-bearing.
          </p>
        ) : (
          <>
            <p className="px-5 pb-2 text-[12px] text-[var(--muted)]">
              {scanned} senders scanned · {suggestions.length} worth cutting.
              Uncheck any you want to keep.
            </p>
            <div className="min-h-0 flex-1 overflow-y-auto">
              {phoneDups.length > 0 ? (
                <>
                  <p className="flex items-center gap-1.5 bg-[var(--card)] px-4 py-1.5 text-[11px] font-bold uppercase tracking-wide text-[var(--muted)]">
                    <Smartphone className="h-3.5 w-3.5" />
                    Your phone already tells you · {phoneDups.length}
                  </p>
                  <ul>{phoneDups.map(row)}</ul>
                </>
              ) : null}
              {rest.length > 0 ? (
                <>
                  <p className="bg-[var(--card)] px-4 py-1.5 text-[11px] font-bold uppercase tracking-wide text-[var(--muted)]">
                    Lists you never read · {rest.length}
                  </p>
                  <ul>{rest.map(row)}</ul>
                </>
              ) : null}
            </div>
            <div className="border-t border-[var(--border)] p-4">
              <button
                type="button"
                disabled={picked.size === 0 || running}
                onClick={execute}
                className="flex w-full items-center justify-center gap-2 rounded-xl bg-[#a855f7] py-3 text-[15px] font-semibold text-white disabled:opacity-50"
              >
                {running ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <BellOff className="h-4 w-4" />
                )}
                {running
                  ? "Cutting them loose…"
                  : `Unsubscribe from ${picked.size} senders`}
              </button>
              <p className="mt-2 text-center text-[11px] text-[var(--muted)]">
                Real unsubscribes where the list supports it — every sender
                muted (future mail auto-deletes) either way.
              </p>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
