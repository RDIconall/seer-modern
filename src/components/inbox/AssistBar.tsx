"use client";

import type { ReaderMessage } from "@/lib/inbox/types";
import {
  Calendar,
  Check,
  ExternalLink,
  HelpCircle,
  Sparkles,
  UserCheck,
  X,
} from "lucide-react";

/**
 * The "make it easy" strip in the reader: one-tap calendar RSVP,
 * one-tap links pulled from the body (track / RSVP / pay), one-tap AI
 * reply drafts, and a one-tap handoff to the user's EA.
 */
export function AssistBar({
  reader,
  drafting,
  onDraft,
  rsvping,
  onRsvp,
}: {
  reader: ReaderMessage;
  drafting: boolean;
  onDraft: (intent?: "yes" | "no" | "later" | "delegate") => void;
  rsvping?: boolean;
  onRsvp?: (response: "accepted" | "declined" | "tentative") => void;
}) {
  const action = reader.guide?.action;
  const wantsReply =
    !action ||
    action === "respond" ||
    action === "act_today" ||
    action === "needs_review";
  const keyActions = reader.keyActions ?? [];
  const invite = reader.calendarEvent;

  if (!wantsReply && keyActions.length === 0 && !invite) return null;

  return (
    <div className="mt-3 space-y-2">
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

      {wantsReply ? (
        <div className="flex flex-wrap items-center gap-1.5">
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
          <button
            type="button"
            disabled={drafting}
            onClick={() => onDraft("delegate")}
            className="inline-flex items-center gap-1 rounded-full bg-[var(--card)] px-3 py-1.5 text-[12px] font-medium text-[var(--fg)] disabled:opacity-50"
          >
            <UserCheck className="h-3.5 w-3.5" />
            Delegate to EA
          </button>
        </div>
      ) : null}
    </div>
  );
}
