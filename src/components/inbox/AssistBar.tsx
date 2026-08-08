"use client";

import type { ReaderMessage } from "@/lib/inbox/types";
import {
  BellOff,
  Calendar,
  CalendarClock,
  Check,
  ExternalLink,
  HelpCircle,
  Paperclip,
  Sparkles,
  UserCheck,
  X,
} from "lucide-react";

/**
 * The "make it easy" strip in the reader: one-tap calendar RSVP,
 * one-tap links pulled from the body (track / RSVP / pay), one-tap AI
 * reply drafts, and a one-tap handoff to the user's EA.
 */
function prettySize(bytes: number): string {
  if (bytes >= 1_000_000) return `${(bytes / 1_000_000).toFixed(1)} MB`;
  if (bytes >= 1_000) return `${Math.round(bytes / 1_000)} KB`;
  return bytes > 0 ? `${bytes} B` : "";
}

export function AssistBar({
  reader,
  messageId,
  drafting,
  onDraft,
  rsvping,
  onRsvp,
  onUnsubscribe,
  onDelegate,
  onSchedule,
}: {
  reader: ReaderMessage;
  /** Needed to build attachment download URLs */
  messageId?: string;
  drafting: boolean;
  onDraft: (intent?: "yes" | "no" | "later" | "delegate") => void;
  rsvping?: boolean;
  onRsvp?: (response: "accepted" | "declined" | "tentative") => void;
  onUnsubscribe?: () => void;
  /** Opens the delegate "to who?" sheet. */
  onDelegate?: () => void;
  /** Opens the "Schedule it" time-blocking sheet. */
  onSchedule?: () => void;
}) {
  const action = reader.guide?.action;
  const wantsReply =
    !action ||
    action === "respond" ||
    action === "act_today" ||
    action === "needs_review";
  const keyActions = reader.keyActions ?? [];
  const invite = reader.calendarEvent;
  const ask = reader.guide?.ask;
  const wantsUnsub =
    action === "unsubscribe" ||
    action === "glance_promo" ||
    action === "review_subscription";

  // Delegate + Time block are universal actions — the bar always renders
  // when their handlers exist, on every kind of email.

  const attachments = reader.attachments ?? [];

  return (
    <div className="mt-3 space-y-2">
      {attachments.length > 0 && messageId ? (
        <div className="flex flex-wrap gap-1.5">
          {attachments.map((a) => (
            <a
              key={a.id}
              href={`/api/messages/${messageId}/attachment?aid=${encodeURIComponent(a.id)}&name=${encodeURIComponent(a.filename)}&type=${encodeURIComponent(a.mimeType)}`}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex max-w-full items-center gap-1.5 rounded-lg border border-[var(--border)] bg-[var(--card)] px-2.5 py-1.5 text-[12px] font-medium"
            >
              <Paperclip className="h-3.5 w-3.5 shrink-0 text-[var(--primary)]" />
              <span className="truncate">{a.filename}</span>
              {a.size > 0 ? (
                <span className="shrink-0 text-[10px] text-[var(--muted)]">
                  {prettySize(a.size)}
                </span>
              ) : null}
            </a>
          ))}
        </div>
      ) : null}
      {ask ? (
        <div className="rounded-xl border-l-4 border-[var(--primary)] bg-[var(--primary-soft,rgba(52,152,217,0.08))] px-3 py-2.5">
          <div className="text-[10px] font-semibold uppercase tracking-wide text-[var(--primary)]">
            The ask
          </div>
          <p className="mt-0.5 text-[14px] font-medium leading-snug">
            “{ask}”
          </p>
        </div>
      ) : null}
      {invite && onRsvp ? (
        <div className="rounded-xl border border-[var(--border)] bg-[var(--card)] px-3 py-2.5">
          <div className="mb-2 flex items-center gap-1.5 text-[12px] font-semibold">
            <Calendar className="h-3.5 w-3.5 text-[var(--primary)]" />
            <span className="truncate">{invite.subject}</span>
          </div>
          {invite.myStatus && invite.myStatus !== "needsAction" ? (
            <p className="text-[12px] text-[var(--muted)]">
              You responded:{" "}
              <span className="font-semibold text-[var(--fg)]">
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
                className="inline-flex items-center gap-1 rounded-full bg-[#0b8043] px-3 py-1.5 text-[12px] font-semibold text-white disabled:opacity-50"
              >
                <Check className="h-3.5 w-3.5" />
                Going
              </button>
              <button
                type="button"
                disabled={rsvping}
                onClick={() => onRsvp("tentative")}
                className="inline-flex items-center gap-1 rounded-full bg-[var(--bg)] px-3 py-1.5 text-[12px] font-medium text-[var(--fg)] disabled:opacity-50"
              >
                <HelpCircle className="h-3.5 w-3.5" />
                Maybe
              </button>
              <button
                type="button"
                disabled={rsvping}
                onClick={() => onRsvp("declined")}
                className="inline-flex items-center gap-1 rounded-full bg-[#d93025] px-3 py-1.5 text-[12px] font-semibold text-white disabled:opacity-50"
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
              className="inline-flex items-center gap-1 rounded-full bg-[var(--primary)] px-3 py-1.5 text-[12px] font-semibold text-white"
            >
              <ExternalLink className="h-3.5 w-3.5" />
              {k.label}
            </a>
          ))}
        </div>
      ) : null}

      <div className="flex flex-wrap items-center gap-1.5">
        {wantsReply ? (
          <>
            <button
              type="button"
              disabled={drafting}
              onClick={() => onDraft()}
              className="inline-flex items-center gap-1 rounded-full border border-[var(--primary)] px-3 py-1.5 text-[12px] font-semibold text-[var(--primary)] disabled:opacity-50"
            >
              <Sparkles className="h-3.5 w-3.5" />
              {drafting ? "Drafting…" : "Draft reply"}
            </button>
            {(["yes", "no", "later"] as const).map((intent) => (
              <button
                key={intent}
                type="button"
                disabled={drafting}
                onClick={() => onDraft(intent)}
                className="rounded-full bg-[var(--card)] px-3 py-1.5 text-[12px] font-medium text-[var(--fg)] disabled:opacity-50"
              >
                {intent === "yes" ? "Say yes" : intent === "no" ? "Decline" : "Buy time"}
              </button>
            ))}
          </>
        ) : null}
        {onDelegate ? (
          <button
            type="button"
            disabled={drafting}
            onClick={onDelegate}
            className="inline-flex items-center gap-1 rounded-full bg-[var(--card)] px-3 py-1.5 text-[12px] font-medium text-[var(--fg)] disabled:opacity-50"
          >
            <UserCheck className="h-3.5 w-3.5" />
            Delegate…
          </button>
        ) : null}
        {onSchedule ? (
          <button
            type="button"
            onClick={onSchedule}
            className="inline-flex items-center gap-1 rounded-full bg-[var(--card)] px-3 py-1.5 text-[12px] font-medium text-[var(--fg)]"
          >
            <CalendarClock className="h-3.5 w-3.5" />
            Time block
          </button>
        ) : null}
        {wantsUnsub && onUnsubscribe ? (
          <button
            type="button"
            onClick={onUnsubscribe}
            className="inline-flex items-center gap-1 rounded-full border border-[#a855f7] px-3 py-1.5 text-[12px] font-semibold text-[#a855f7]"
          >
            <BellOff className="h-3.5 w-3.5" />
            Unsubscribe for real
          </button>
        ) : null}
      </div>
    </div>
  );
}
