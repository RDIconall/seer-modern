"use client";

import { ChevronLeft, Send } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { RichText, type RichValue } from "@/components/inbox/RichText";

type Contact = { name?: string; email: string };

/**
 * Recipient field with contact suggestions. Addresses are comma-separated,
 * so completion applies to the LAST entry only — picking someone leaves
 * the ones already typed alone.
 */
function RecipientField({
  label,
  value,
  onChange,
  placeholder,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder: string;
}) {
  const [open, setOpen] = useState(false);
  const [matches, setMatches] = useState<Contact[]>([]);
  const boxRef = useRef<HTMLDivElement>(null);

  const lastEntry = value.split(",").pop()?.trim() ?? "";

  useEffect(() => {
    if (!open) return;
    const q = lastEntry;
    // An exact address is already chosen — nothing left to suggest.
    if (q.includes("@") && q.endsWith(" ")) {
      setMatches([]);
      return;
    }
    const id = setTimeout(async () => {
      try {
        const res = await fetch(`/api/contacts?q=${encodeURIComponent(q)}`, {
          cache: "no-store",
        });
        if (!res.ok) return;
        const json = (await res.json()) as { contacts?: Contact[] };
        setMatches(json.contacts ?? []);
      } catch {
        /* suggestions are optional */
      }
    }, 150);
    return () => clearTimeout(id);
  }, [lastEntry, open]);

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (!boxRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, []);

  const pick = (c: Contact) => {
    const parts = value.split(",");
    parts[parts.length - 1] = ` ${c.email}`;
    onChange(`${parts.join(",").replace(/^\s+/, "")}, `);
    setMatches([]);
  };

  return (
    <div ref={boxRef} className="relative border-b border-[var(--border)]">
      <label className="flex items-center gap-3 py-3 text-[14px]">
        <span className="w-8 shrink-0 text-[var(--muted)]">{label}</span>
        <input
          value={value}
          onChange={(e) => {
            onChange(e.target.value);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          className="min-w-0 flex-1 bg-transparent outline-none"
          placeholder={placeholder}
          autoComplete="off"
          inputMode="email"
        />
      </label>
      {open && matches.length > 0 ? (
        <ul className="absolute left-0 right-0 top-full z-10 max-h-64 overflow-auto rounded-b border border-[var(--border)] bg-[var(--card)] shadow-lg">
          {matches.map((c) => (
            <li key={c.email}>
              <button
                type="button"
                onClick={() => pick(c)}
                className="flex w-full flex-col items-start px-3 py-2 text-left hover:bg-[var(--row-hover)]"
              >
                {c.name ? (
                  <span className="text-[14px] text-[var(--fg-strong)]">
                    {c.name}
                  </span>
                ) : null}
                <span className="text-[12px] text-[var(--muted)]">
                  {c.email}
                </span>
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

export type ComposeMode = "compose" | "reply" | "replyAll" | "forward";

export type ComposeDraft = {
  mode: ComposeMode;
  to: string;
  cc: string;
  subject: string;
  body: string;
  replyToId?: string;
  /** Delegation handoffs: archive the original once the forward sends */
  archiveOriginal?: boolean;
};

/**
 * A pre-filled draft (an AI reply, a nudge, a delegation note) arrives as
 * plain text — it has to be seeded into the editor as markup, or the body
 * the user was shown a moment ago comes up blank.
 */
function textToHtml(text: string): string {
  if (!text) return "";
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\r?\n/g, "<br>");
}

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
  const [rich, setRich] = useState<RichValue>({
    html: textToHtml(draft.body),
    text: draft.body,
  });
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
          body: rich.text,
          html: rich.html || undefined,
          replyToId: draft.replyToId,
          archiveOriginal: draft.archiveOriginal,
        }),
      });
      // An empty body (a timed-out or killed function) makes res.json()
      // throw "Unexpected end of JSON input", which tells the user nothing.
      // Read the text first and report what actually happened.
      const raw = await res.text();
      let json: { error?: string } = {};
      if (raw) {
        try {
          json = JSON.parse(raw) as { error?: string };
        } catch {
          throw new Error(
            res.ok
              ? "Sent, but the reply from the server was unreadable."
              : `Send failed (${res.status})`,
          );
        }
      } else if (!res.ok) {
        throw new Error(
          res.status === 504
            ? "The server took too long. Check Sent before retrying."
            : `Send failed (${res.status})`,
        );
      }
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
        <h2 className="flex-1 text-[17px] font-bold">{title}</h2>
        <button
          type="button"
          disabled={sending}
          onClick={submit}
          className="mr-2 inline-flex items-center gap-1.5 rounded-full bg-[var(--primary)] px-4 py-2 text-[14px] text-white disabled:opacity-50"
        >
          <Send className="h-4 w-4" />
          {sending ? "Sending" : "Send"}
        </button>
      </header>

      <div className="flex flex-1 flex-col overflow-auto px-4">
        <RecipientField
          label="To"
          value={to}
          onChange={setTo}
          placeholder="Recipients"
        />
        <RecipientField label="Cc" value={cc} onChange={setCc} placeholder="Cc" />
        <label className="flex items-center gap-3 border-b border-[var(--border)] py-3 text-[14px]">
          <span className="w-8 shrink-0 text-[var(--muted)]">Subj</span>
          <input
            value={subject}
            onChange={(e) => setSubject(e.target.value)}
            className="min-w-0 flex-1 bg-transparent outline-none"
            placeholder="Subject"
          />
        </label>
        <div className="mt-3 flex min-h-0 flex-1 flex-col">
          <RichText
            value={rich}
            onChange={setRich}
            autoFocus
            minHeight={320}
            placeholder={
              draft.mode === "forward"
                ? "Add a note (optional)"
                : draft.mode === "reply" || draft.mode === "replyAll"
                  ? "Your reply"
                  : "Compose email"
            }
          />
        </div>
        {draft.mode !== "compose" ? (
          <p className="mb-2 text-[12px] text-[var(--muted)]">
            {draft.mode === "forward"
              ? "The original email is included below your note automatically."
              : "The original message is quoted below your reply automatically."}
          </p>
        ) : null}
        {error ? (
          <p className="mb-4 rounded-lg bg-[#d63b2f]/10 px-3 py-2 text-[14px] text-[#d63b2f]">
            {error}
          </p>
        ) : null}
      </div>
    </div>
  );
}
