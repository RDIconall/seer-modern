"use client";

import type { ReaderMessage } from "@/lib/inbox/types";
import {
  Calendar,
  Check,
  ExternalLink,
  HelpCircle,
  Paperclip,
  X,
} from "lucide-react";

/**
 * Substance only: the ask, an invitation you can answer, links lifted out
 * of the body, and attachments. Nothing here narrates and nothing repeats
 * the toolbar — the canned "Say yes / Decline / Buy time" replies are gone,
 * and every secondary action lives in the reader's overflow menu.
 */
function prettySize(bytes: number): string {
  if (bytes >= 1_000_000) return `${(bytes / 1_000_000).toFixed(1)} MB`;
  if (bytes >= 1_000) return `${Math.round(bytes / 1_000)} KB`;
  return bytes > 0 ? `${bytes} B` : "";
}

export function AssistBar({
  reader,
  messageId,
  rsvping,
  onRsvp,
}: {
  reader: ReaderMessage;
  /** Needed to build attachment download URLs */
  messageId?: string;
  rsvping?: boolean;
  onRsvp?: (response: "accepted" | "declined" | "tentative") => void;
}) {
  const keyActions = reader.keyActions ?? [];
  const invite = reader.calendarEvent;
  const ask = reader.guide?.ask;
  const attachments = reader.attachments ?? [];

  if (
    attachments.length === 0 &&
    !ask &&
    !(invite && onRsvp) &&
    keyActions.length === 0
  ) {
    return null;
  }

  return (
    <div className="space-y-2">
      {ask ? (
        <div className="rounded-xl border-l-4 border-[var(--primary)] bg-[var(--primary-soft,rgba(52,152,217,0.08))] px-3 py-2.5">
          <div className="text-[12px] uppercase tracking-wide text-[var(--primary)]">
            The ask
          </div>
          <p className="mt-0.5 text-[17px] font-bold leading-snug">
            “{ask}”
          </p>
        </div>
      ) : null}
      {invite && onRsvp ? (
        <div className="rounded-xl border border-[var(--border)] bg-[var(--card)] px-3 py-2.5">
          <div className="mb-2 flex items-center gap-1.5 text-[14px]">
            <Calendar className="h-3.5 w-3.5 text-[var(--primary)]" />
            <span className="truncate">{invite.subject}</span>
          </div>
          {invite.myStatus && invite.myStatus !== "needsAction" ? (
            <p className="text-[14px] text-[var(--muted)]">
              You responded:{" "}
              <span className="text-[var(--fg)]">
                {invite.myStatus === "accepted"
                  ? "Going"
                  : invite.myStatus === "declined"
                    ? "Not going"
                    : "Maybe"}
              </span>{" "}
              — it&apos;s on your calendar.
            </p>
          ) : (
            <div className="flex flex-wrap gap-1.5">
              <button
                type="button"
                disabled={rsvping}
                onClick={() => onRsvp("accepted")}
                className="inline-flex items-center gap-1 rounded-full bg-[#0b8043] px-3 py-1.5 text-[14px] text-white disabled:opacity-50"
              >
                <Check className="h-3.5 w-3.5" />
                Going
              </button>
              <button
                type="button"
                disabled={rsvping}
                onClick={() => onRsvp("tentative")}
                className="inline-flex items-center gap-1 rounded-full bg-[var(--bg)] px-3 py-1.5 text-[14px] text-[var(--fg)] disabled:opacity-50"
              >
                <HelpCircle className="h-3.5 w-3.5" />
                Maybe
              </button>
              <button
                type="button"
                disabled={rsvping}
                onClick={() => onRsvp("declined")}
                className="inline-flex items-center gap-1 rounded-full bg-[#d93025] px-3 py-1.5 text-[14px] text-white disabled:opacity-50"
              >
                <X className="h-3.5 w-3.5" />
                Can&apos;t go
              </button>
            </div>
          )}
        </div>
      ) : null}
      {keyActions.length > 0 ? (
        <div className="flex flex-wrap gap-1.5">
          {keyActions.map((k) => (
            <a
              key={k.url}
              href={k.url}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 rounded-full bg-[var(--primary)] px-3 py-1.5 text-[14px] text-white"
            >
              <ExternalLink className="h-3.5 w-3.5" />
              {k.label}
            </a>
          ))}
        </div>
      ) : null}
      {attachments.length > 0 && messageId ? (
        <div className="flex flex-wrap gap-1.5">
          {attachments.map((a) => (
            <a
              key={a.id}
              href={`/api/messages/${messageId}/attachment?aid=${encodeURIComponent(a.id)}&name=${encodeURIComponent(a.filename)}&type=${encodeURIComponent(a.mimeType)}`}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex max-w-full items-center gap-1.5 rounded-lg border border-[var(--border)] bg-[var(--card)] px-2.5 py-1.5 text-[14px]"
            >
              <Paperclip className="h-3.5 w-3.5 shrink-0 text-[var(--primary)]" />
              <span className="truncate">{a.filename}</span>
              {a.size > 0 ? (
                <span className="shrink-0 text-[12px] text-[var(--muted)]">
                  {prettySize(a.size)}
                </span>
              ) : null}
            </a>
          ))}
        </div>
      ) : null}
    </div>
  );
}
