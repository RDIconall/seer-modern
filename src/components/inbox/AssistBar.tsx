"use client";

import type { ReaderMessage } from "@/lib/inbox/types";
import { Calendar, Check, HelpCircle, Paperclip, X } from "lucide-react";

/**
 * Only what Outlook itself shows around a message: its attachments and, when
 * the mail is a real calendar invite, inline accept / maybe / decline. The
 * Seer-specific "The ask" callout and the links lifted out of the body — the
 * interim panel between the header and the message — are gone. Everything the
 * assistant can do lives in the reader's overflow menu instead.
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
  const invite = reader.calendarEvent;
  const attachments = reader.attachments ?? [];

  if (attachments.length === 0 && !(invite && onRsvp)) {
    return null;
  }

  return (
    <div className="space-y-2">
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
