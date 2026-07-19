"use client";

import type { ReaderMessage } from "@/lib/inbox/types";
import { ExternalLink, Sparkles } from "lucide-react";

/**
 * The "make it easy" strip in the reader: one-tap links pulled from the
 * body (track / RSVP / pay) and one-tap AI reply drafts.
 */
export function AssistBar({
  reader,
  drafting,
  onDraft,
}: {
  reader: ReaderMessage;
  drafting: boolean;
  onDraft: (intent?: "yes" | "no" | "later") => void;
}) {
  const action = reader.guide?.action;
  const wantsReply =
    !action ||
    action === "respond" ||
    action === "act_today" ||
    action === "needs_review";
  const keyActions = reader.keyActions ?? [];

  if (!wantsReply && keyActions.length === 0) return null;

  return (
    <div className="mt-3 space-y-2">
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
        </div>
      ) : null}
    </div>
  );
}
