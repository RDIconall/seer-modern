"use client";

import * as React from "react";
import { useEffect, useState } from "react";
import { Sparkles, X } from "lucide-react";
import type { Command } from "@/lib/v2/commands/types";
import type { MailboxRow } from "@/lib/v3/mailbox/types";
import type { MatterSuggestion } from "@/lib/v2/intelligence/user-matter";

type PlaceOptions = {
  matterId?: string;
  matterTitle?: string;
  createMatter?: boolean;
};

/**
 * Putting a conversation on a matter is a correction to Seer's reading, and a
 * correction is law: the conversation joins that matter's group in the Inbox
 * and stops being asked about on its own.
 */
export const matterCommand = (
  row: Pick<MailboxRow, "conversationId">,
  options: PlaceOptions = {},
): Command => ({
  type: "triageConversation",
  conversationId: row.conversationId,
  destination: "matter",
  ...options,
});

/** Choose the matter a conversation belongs to, or let Seer place it. */
export function MatterPicker({
  row,
  onPlace,
  onClose,
}: {
  row: MailboxRow;
  onPlace: (command: Command) => void;
  onClose: () => void;
}) {
  const [choices, setChoices] = useState<MatterSuggestion[]>([]);
  const [loading, setLoading] = useState(true);
  const [newTitle, setNewTitle] = useState(
    row.subject.replace(/^(?:re|fw|fwd):\s*/i, "").trim(),
  );

  useEffect(() => {
    let current = true;
    void (async () => {
      try {
        const response = await fetch(
          `/api/v3/matter-suggestions?conversationId=${encodeURIComponent(
            row.conversationId,
          )}`,
        );
        const json = (await response.json()) as { matters?: MatterSuggestion[] };
        if (current && response.ok) setChoices(json.matters ?? []);
      } catch {
        // Creating a new matter and Seer's auto-placement still work offline.
        if (current) setChoices([]);
      } finally {
        if (current) setLoading(false);
      }
    })();
    return () => {
      current = false;
    };
  }, [row.conversationId]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  const place = (options?: PlaceOptions) => onPlace(matterCommand(row, options));

  return (
    <div
      className="matter-picker-backdrop"
      role="presentation"
      onPointerDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <section
        className="matter-picker"
        role="dialog"
        aria-modal="true"
        aria-labelledby="matter-picker-title"
      >
        <header>
          <div>
            <h2 id="matter-picker-title">Add to a matter</h2>
            <p>{row.subject || "(no subject)"}</p>
          </div>
          <button type="button" aria-label="Close matter picker" onClick={onClose}>
            <X aria-hidden />
          </button>
        </header>

        <button type="button" className="matter-picker-ai" onClick={() => place()}>
          <Sparkles aria-hidden />
          <span>
            <strong>Let Seer place it</strong>
            <small>Reuse a related matter, or create the right one.</small>
          </span>
        </button>

        {loading ? (
          <p className="matter-picker-status">Looking for related matters…</p>
        ) : choices.length > 0 ? (
          <div className="matter-picker-list">
            {choices.slice(0, 12).map((matter) => (
              <button
                key={matter.matterId}
                type="button"
                data-related={matter.related ? "true" : undefined}
                onClick={() => place({ matterId: matter.matterId })}
              >
                <span>{matter.shortTitle}</span>
                <small>
                  {matter.related ? "Suggested by Seer" : matter.section ?? "Matter"}
                </small>
              </button>
            ))}
          </div>
        ) : null}

        <form
          className="matter-picker-new"
          onSubmit={(event) => {
            event.preventDefault();
            const title = newTitle.trim();
            if (!title) return;
            place({ matterTitle: title, createMatter: true });
          }}
        >
          <label htmlFor="new-matter-title">New matter</label>
          <div>
            <input
              id="new-matter-title"
              value={newTitle}
              maxLength={120}
              onChange={(event) => setNewTitle(event.target.value)}
            />
            <button type="submit" disabled={!newTitle.trim()}>
              Create
            </button>
          </div>
        </form>
      </section>
    </div>
  );
}
