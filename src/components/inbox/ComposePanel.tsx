"use client";

import { ChevronLeft, Send } from "lucide-react";
import { useState } from "react";

export type ComposeMode = "compose" | "reply" | "replyAll" | "forward";

export type ComposeDraft = {
  mode: ComposeMode;
  to: string;
  cc: string;
  subject: string;
  body: string;
  replyToId?: string;
};

export function ComposePanel({
  draft,
  onClose,
  onSent,
}: {
  draft: ComposeDraft;
  onClose: () => void;
  onSent: () => void;
}) {
  const [to, setTo] = useState(draft.to);
  const [cc, setCc] = useState(draft.cc);
  const [subject, setSubject] = useState(draft.subject);
  const [body, setBody] = useState(draft.body);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const title =
    draft.mode === "compose"
      ? "Compose"
      : draft.mode === "forward"
        ? "Forward"
        : draft.mode === "replyAll"
          ? "Reply all"
          : "Reply";

  async function submit() {
    setSending(true);
    setError(null);
    try {
      const res = await fetch("/api/send", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          mode: draft.mode,
          to,
          cc: cc || undefined,
          subject,
          body,
          replyToId: draft.replyToId,
        }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "Send failed");
      onSent();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Send failed");
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="app-shell fixed inset-0 z-50 flex flex-col bg-[var(--bg)]">
      <header className="flex items-center gap-1 border-b border-[var(--border)] px-1 py-1">
        <button
          type="button"
          onClick={onClose}
          className="flex h-10 w-10 items-center justify-center rounded-full"
          aria-label="Close"
        >
          <ChevronLeft className="h-6 w-6" />
        </button>
        <h2 className="flex-1 text-[15px] font-medium">{title}</h2>
        <button
          type="button"
          disabled={sending}
          onClick={submit}
          className="mr-2 inline-flex items-center gap-1.5 rounded-full bg-[var(--primary)] px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
        >
          <Send className="h-4 w-4" />
          {sending ? "Sending" : "Send"}
        </button>
      </header>

      <div className="flex flex-1 flex-col overflow-auto px-4">
        <label className="flex items-center gap-3 border-b border-[var(--border)] py-3 text-sm">
          <span className="w-8 shrink-0 text-[var(--muted)]">To</span>
          <input
            value={to}
            onChange={(e) => setTo(e.target.value)}
            className="min-w-0 flex-1 bg-transparent outline-none"
            placeholder="Recipients"
            autoComplete="email"
            inputMode="email"
          />
        </label>
        <label className="flex items-center gap-3 border-b border-[var(--border)] py-3 text-sm">
          <span className="w-8 shrink-0 text-[var(--muted)]">Cc</span>
          <input
            value={cc}
            onChange={(e) => setCc(e.target.value)}
            className="min-w-0 flex-1 bg-transparent outline-none"
            placeholder="Cc"
            inputMode="email"
          />
        </label>
        <label className="flex items-center gap-3 border-b border-[var(--border)] py-3 text-sm">
          <span className="w-8 shrink-0 text-[var(--muted)]">Subj</span>
          <input
            value={subject}
            onChange={(e) => setSubject(e.target.value)}
            className="min-w-0 flex-1 bg-transparent outline-none"
            placeholder="Subject"
          />
        </label>
        <textarea
          value={body}
          onChange={(e) => setBody(e.target.value)}
          className="mt-3 min-h-[45vh] flex-1 resize-none bg-transparent text-[15px] leading-relaxed outline-none"
          placeholder="Compose email"
          autoFocus
        />
        {error ? (
          <p className="mb-4 rounded-lg bg-[#d63b2f]/10 px-3 py-2 text-sm text-[#d63b2f]">
            {error}
          </p>
        ) : null}
      </div>
    </div>
  );
}
