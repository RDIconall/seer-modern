"use client";

import { Loader2, Send, UserCheck, UserRoundPlus, X } from "lucide-react";
import { useEffect, useState } from "react";

/**
 * "Delegate" as a real action: pops up, asks WHO, then the AI writes
 * the handoff email ("Conall wanted to get your help with…") as a
 * ready-to-send forward. Destinations beyond email (Asana, …) later.
 */

export type DelegateRecipient = {
  to: string;
  toName?: string;
  instruction?: string;
};

type EaPayload = { ea: { email: string; name?: string } | null };

export function DelegateSheet({
  subject,
  busy,
  onConfirm,
  onClose,
}: {
  subject: string;
  busy: boolean;
  onConfirm: (recipient: DelegateRecipient) => void;
  onClose: () => void;
}) {
  const [ea, setEa] = useState<EaPayload["ea"]>(null);
  const [loadingEa, setLoadingEa] = useState(true);
  const [choice, setChoice] = useState<"ea" | "other">("ea");
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [instruction, setInstruction] = useState("");

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const res = await fetch("/api/ea", { cache: "no-store" });
        const json = (await res.json()) as EaPayload;
        if (!alive) return;
        setEa(json.ea);
        if (!json.ea) setChoice("other");
      } catch {
        if (alive) setChoice("other");
      } finally {
        if (alive) setLoadingEa(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  const targetEmail = choice === "ea" ? (ea?.email ?? "") : email.trim();
  const targetName =
    choice === "ea" ? (ea?.name ?? ea?.email?.split("@")[0]) : name.trim();
  const valid = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(targetEmail);

  return (
    <div className="fixed inset-0 z-[60] flex items-end justify-center bg-black/40 sm:items-center">
      <button
        type="button"
        aria-label="Close"
        className="absolute inset-0"
        onClick={onClose}
      />
      <div className="relative w-full max-w-md rounded-t-2xl bg-[var(--bg)] p-5 shadow-2xl sm:rounded-2xl">
        <div className="mb-1 flex items-center justify-between">
          <h2 className="flex items-center gap-2 text-[16px] font-semibold">
            <UserCheck className="h-4 w-4 text-[var(--primary)]" />
            Delegate this
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
        <p className="mb-4 truncate text-[12px] text-[var(--muted)]">
          {subject}
        </p>

        <div className="space-y-2">
          {loadingEa ? (
            <div className="flex items-center gap-2 rounded-xl border border-[var(--border)] px-3 py-3 text-sm text-[var(--muted)]">
              <Loader2 className="h-4 w-4 animate-spin" /> Loading…
            </div>
          ) : ea ? (
            <button
              type="button"
              onClick={() => setChoice("ea")}
              className={`flex w-full items-center gap-3 rounded-xl border px-3 py-3 text-left ${
                choice === "ea"
                  ? "border-[var(--primary)] bg-[var(--primary-soft,rgba(52,152,217,0.08))]"
                  : "border-[var(--border)]"
              }`}
            >
              <div className="flex h-9 w-9 items-center justify-center rounded-full bg-[var(--primary)] text-sm font-semibold text-white">
                {(ea.name ?? ea.email)[0]?.toUpperCase()}
              </div>
              <div className="min-w-0">
                <div className="text-sm font-medium">
                  {ea.name ?? "Your EA"}
                </div>
                <div className="truncate text-xs text-[var(--muted)]">
                  {ea.email}
                </div>
              </div>
            </button>
          ) : null}

          <button
            type="button"
            onClick={() => setChoice("other")}
            className={`flex w-full items-center gap-3 rounded-xl border px-3 py-3 text-left ${
              choice === "other"
                ? "border-[var(--primary)] bg-[var(--primary-soft,rgba(52,152,217,0.08))]"
                : "border-[var(--border)]"
            }`}
          >
            <div className="flex h-9 w-9 items-center justify-center rounded-full bg-[var(--card)]">
              <UserRoundPlus className="h-4 w-4" />
            </div>
            <div className="text-sm font-medium">Someone else</div>
          </button>

          {choice === "other" ? (
            <div className="flex gap-2">
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="their@email.com"
                className="min-w-0 flex-[3] rounded-xl border border-[var(--border)] bg-[var(--bg)] px-3 py-2.5 text-sm outline-none focus:border-[var(--primary)]"
                autoFocus
              />
              <input
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Name"
                className="min-w-0 flex-[2] rounded-xl border border-[var(--border)] bg-[var(--bg)] px-3 py-2.5 text-sm outline-none focus:border-[var(--primary)]"
              />
            </div>
          ) : null}

          <input
            type="text"
            value={instruction}
            onChange={(e) => setInstruction(e.target.value)}
            placeholder="What do you want done? (optional — AI reads the email)"
            className="w-full rounded-xl border border-[var(--border)] bg-[var(--bg)] px-3 py-2.5 text-sm outline-none focus:border-[var(--primary)]"
          />
        </div>

        <button
          type="button"
          disabled={!valid || busy}
          onClick={() =>
            onConfirm({
              to: targetEmail,
              toName: targetName || undefined,
              instruction: instruction.trim() || undefined,
            })
          }
          className="mt-4 flex w-full items-center justify-center gap-2 rounded-xl bg-[var(--primary)] py-3 text-[15px] font-semibold text-white disabled:opacity-50"
        >
          {busy ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <Send className="h-4 w-4" />
          )}
          {busy ? "Writing the handoff…" : "Write the handoff email"}
        </button>
        <p className="mt-2 text-center text-[11px] text-[var(--muted)]">
          AI drafts it for your review — sending also archives the original.
          Asana &amp; other destinations coming.
        </p>
      </div>
    </div>
  );
}
