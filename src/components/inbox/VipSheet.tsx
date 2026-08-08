"use client";

import { Crown, Loader2, Plus, X } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

/**
 * The VIP list — Seer's thesis made adjustable: history proposes who
 * matters (writes, meetings, contacts, profile mentions), the user
 * confirms with one tap. VIP mail is never auto-handled downward.
 */

type Vip = { email: string; name?: string; reason?: string };
type Suggestion = { email: string; score: number; evidence: string };

export function VipSheet({
  onClose,
  onChanged,
}: {
  onClose: () => void;
  onChanged?: () => void;
}) {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [vips, setVips] = useState<Vip[]>([]);
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [manual, setManual] = useState("");

  const load = useCallback(async () => {
    setError(null);
    try {
      const res = await fetch("/api/vips", { cache: "no-store" });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "Load failed");
      setVips(json.vips ?? []);
      setSuggestions(json.suggestions ?? []);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Load failed");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const setVip = async (email: string, vip: boolean) => {
    setBusy(email);
    try {
      const res = await fetch("/api/vips", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, vip }),
      });
      if (!res.ok) throw new Error((await res.json()).error);
      await load();
      onChanged?.();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Save failed");
    } finally {
      setBusy(null);
    }
  };

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
            <Crown className="h-4 w-4 text-[#eab308]" />
            VIPs
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
        <p className="px-5 pb-2 text-[12px] text-[var(--muted)]">
          VIP mail always surfaces and is never auto-deleted. Suggestions
          come from your own history — who you write to, meet with, and
          named in your profile.
        </p>

        {error ? (
          <p className="mx-5 mb-2 rounded-lg bg-red-500/10 px-3 py-2 text-sm text-red-600">
            {error}
          </p>
        ) : null}

        {loading ? (
          <div className="flex items-center justify-center gap-2 px-5 py-10 text-sm text-[var(--muted)]">
            <Loader2 className="h-5 w-5 animate-spin text-[#eab308]" />
            Reading your history…
          </div>
        ) : (
          <div className="min-h-0 flex-1 overflow-y-auto pb-4">
            {vips.length > 0 ? (
              <>
                <p className="bg-[var(--card)] px-4 py-1.5 text-[11px] font-bold uppercase tracking-wide text-[var(--muted)]">
                  Your VIPs · {vips.length}
                </p>
                <ul>
                  {vips.map((v) => (
                    <li
                      key={v.email}
                      className="flex items-center gap-2.5 border-b border-[var(--border)] px-4 py-2.5"
                    >
                      <Crown className="h-4 w-4 shrink-0 text-[#eab308]" />
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-[14px] font-semibold">
                          {v.name || v.email}
                        </div>
                        <div className="truncate text-[11px] text-[var(--muted)]">
                          {v.email}
                        </div>
                      </div>
                      <button
                        type="button"
                        disabled={busy === v.email}
                        onClick={() => setVip(v.email, false)}
                        className="shrink-0 rounded-full border border-[var(--border)] px-2.5 py-1 text-[11px] font-medium text-[var(--muted)] disabled:opacity-50"
                      >
                        Remove
                      </button>
                    </li>
                  ))}
                </ul>
              </>
            ) : null}

            {suggestions.length > 0 ? (
              <>
                <p className="bg-[var(--card)] px-4 py-1.5 text-[11px] font-bold uppercase tracking-wide text-[var(--muted)]">
                  Suggested from your history · {suggestions.length}
                </p>
                <ul>
                  {suggestions.map((s) => (
                    <li
                      key={s.email}
                      className="flex items-center gap-2.5 border-b border-[var(--border)] px-4 py-2.5"
                    >
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-[14px] font-medium">
                          {s.email}
                        </div>
                        <div className="truncate text-[11px] text-[var(--muted)]">
                          {s.evidence}
                        </div>
                      </div>
                      <button
                        type="button"
                        disabled={busy === s.email}
                        onClick={() => setVip(s.email, true)}
                        className="inline-flex shrink-0 items-center gap-1 rounded-full bg-[#eab308] px-2.5 py-1 text-[11px] font-bold text-white disabled:opacity-50"
                      >
                        <Plus className="h-3 w-3" />
                        VIP
                      </button>
                    </li>
                  ))}
                </ul>
              </>
            ) : null}

            <div className="flex gap-2 px-4 pt-3">
              <input
                type="email"
                value={manual}
                onChange={(e) => setManual(e.target.value)}
                placeholder="Add any email as VIP"
                className="min-w-0 flex-1 rounded-xl border border-[var(--border)] bg-[var(--bg)] px-3 py-2 text-sm outline-none focus:border-[#eab308]"
              />
              <button
                type="button"
                disabled={!/@/.test(manual) || busy === manual}
                onClick={() => {
                  setVip(manual.trim(), true);
                  setManual("");
                }}
                className="shrink-0 rounded-xl bg-[#eab308] px-3 py-2 text-sm font-semibold text-white disabled:opacity-50"
              >
                Add
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
