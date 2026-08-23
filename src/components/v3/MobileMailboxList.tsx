"use client";

import * as React from "react";
import { useMemo, useState } from "react";
import { Sparkles, X } from "lucide-react";
import type { Command, CommandResult } from "@/lib/v2/commands/types";
import type { MailboxRow, MailboxView } from "@/lib/v3/mailbox/types";
import { triagePiles } from "@/lib/v3/mailbox/triage-verb";
import { MobileMailRow } from "./MobileMailRow";
import type { MatterSuggestion } from "@/lib/v2/intelligence/user-matter";

const mobileTime = (iso: string) => {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const today = new Date();
  if (date.toDateString() === today.toDateString()) {
    return date.toLocaleTimeString(undefined, {
      hour: "numeric",
      minute: "2-digit",
    });
  }
  return date.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
};

/**
 * Triage sends a conversation to Atlas, to the archive, or to the bin. Making
 * it a matter is a correction to Seer's reading, and a correction is law: the
 * conversation appears on the whiteboard and stops being asked about.
 */
const matterCommand = (
  row: MailboxRow,
  options: {
    matterId?: string;
    matterTitle?: string;
    createMatter?: boolean;
  } = {},
): Command => ({
  type: "triageConversation",
  conversationId: row.conversationId,
  destination: "matter",
  ...options,
});

const triageArchiveCommand = (row: MailboxRow): Command => ({
  type: "triageConversation",
  conversationId: row.conversationId,
  destination: "archive",
});

const triageDeleteCommand = (row: MailboxRow): Command => ({
  type: "triageConversation",
  conversationId: row.conversationId,
  destination: "delete",
});

const archiveCommand = (row: MailboxRow): Command => ({
  type: "archive",
  conversationId: row.conversationId,
});

/** The user is looking straight at this row, so their delete is their own call. */
const deleteCommand = (row: MailboxRow): Command => ({
  type: "delete",
  conversationId: row.conversationId,
  byUser: true,
});

export function MobileMailboxList({
  view,
  triage = false,
  currentConversationId,
  onOpen,
  onCommands,
  onCards,
}: {
  view: MailboxView;
  triage?: boolean;
  currentConversationId?: string | null;
  onOpen: (row: MailboxRow) => void;
  onCommands: (commands: Command[]) => Promise<CommandResult[]>;
  onCards?: () => void;
}) {
  const [hidden, setHidden] = useState<ReadonlySet<string>>(new Set());
  const [matterRow, setMatterRow] = useState<MailboxRow | null>(null);
  const [matterChoices, setMatterChoices] = useState<MatterSuggestion[]>([]);
  const [matterChoicesLoading, setMatterChoicesLoading] = useState(false);
  const [newMatterTitle, setNewMatterTitle] = useState("");

  const act = async (row: MailboxRow, command: Command) => {
    setHidden((current) => new Set(current).add(row.conversationId));
    try {
      const [result] = await onCommands([command]);
      if (!result?.ok) {
        throw new Error(result?.error ?? "action was not queued");
      }
    } catch {
      setHidden((current) => {
        const next = new Set(current);
        next.delete(row.conversationId);
        return next;
      });
    }
  };

  const rows = view.rows.filter((row) => !hidden.has(row.conversationId));
  const groups = useMemo(
    () =>
      triage
        ? triagePiles(rows, new Set()).map((pile) => ({
            key: pile.verb,
            label: pile.label,
            hint: pile.hint,
            rows: pile.days.flatMap((day) => day.rows),
          }))
        : [{ key: view.folder, label: "", hint: "", rows }],
    [rows, triage, view.folder],
  );

  const sweep = async (
    groupRows: MailboxRow[],
    command: (row: MailboxRow) => Command,
  ) => {
    setHidden((current) => {
      const next = new Set(current);
      for (const row of groupRows) next.add(row.conversationId);
      return next;
    });
    const results = await onCommands(groupRows.map(command));
    const failedIds = groupRows
      .filter((_, index) => !results[index]?.ok)
      .map((row) => row.conversationId);
    if (failedIds.length > 0) {
      setHidden((current) => {
        const next = new Set(current);
        for (const id of failedIds) next.delete(id);
        return next;
      });
    }
  };

  const openMatterPicker = async (row: MailboxRow) => {
    setMatterRow(row);
    setNewMatterTitle(row.subject.replace(/^(?:re|fw|fwd):\s*/i, "").trim());
    setMatterChoices([]);
    setMatterChoicesLoading(true);
    try {
      const response = await fetch(
        `/api/v3/matter-suggestions?conversationId=${encodeURIComponent(
          row.conversationId,
        )}`,
      );
      const json = (await response.json()) as {
        matters?: MatterSuggestion[];
      };
      if (response.ok) setMatterChoices(json.matters ?? []);
    } catch {
      // Creating a new matter and Seer's auto-placement still work offline.
      setMatterChoices([]);
    } finally {
      setMatterChoicesLoading(false);
    }
  };

  const placeOnMatter = (
    row: MailboxRow,
    options?: {
      matterId?: string;
      matterTitle?: string;
      createMatter?: boolean;
    },
  ) => {
    setMatterRow(null);
    void act(row, matterCommand(row, options));
  };

  const renderRow = (row: MailboxRow) => (
    <MobileMailRow
      key={row.conversationId}
      model={{
        id: row.conversationId,
        from: row.senderDisplayName,
        subject: row.subject,
        preview:
          (triage ? row.decisionSummary : null) ||
          row.snippet ||
          "No preview available",
        when: mobileTime(row.timestamp),
        isUnread: row.isUnread,
        attachmentCount: row.attachments.length,
      }}
      current={row.conversationId === currentConversationId}
      onOpen={() => onOpen(row)}
      onArchive={() =>
        void act(
          row,
          triage ? triageArchiveCommand(row) : archiveCommand(row),
        )
      }
      onDelete={() =>
        void act(row, triage ? triageDeleteCommand(row) : deleteCommand(row))
      }
      onAtlas={
        triage ? () => void act(row, matterCommand(row)) : undefined
      }
      onLongPress={triage ? () => void openMatterPicker(row) : undefined}
      actions={
        triage
          ? [
              { label: "Atlas", run: () => void act(row, matterCommand(row)) },
              {
                label: "Archive",
                run: () => void act(row, triageArchiveCommand(row)),
              },
              {
                label: "Delete",
                run: () => void act(row, triageDeleteCommand(row)),
              },
            ]
          : undefined
      }
    />
  );

  return (
    <section
      className="mobile-mail-list compact-mail-list"
      aria-label={`${triage ? "Triage" : "Inbox"} messages`}
    >
      <header className="compact-mail-header">
        <div>
          <h1>{triage ? "Triage" : "Inbox"}</h1>
          <span className="tabular">
            {triage
              ? `${rows.length} to place${
                  view.processing
                    ? ` · Seer reading ${view.processing}`
                    : ""
                } · Atlas, archive or bin`
              : `${view.total} conversations`}
          </span>
        </div>
        {triage && onCards ? (
          <button type="button" onClick={onCards}>
            Cards
          </button>
        ) : null}
      </header>
      {rows.length === 0 ? (
        <p className="mail-empty">
          {triage ? "Inbox placed. Nothing left to triage." : "Nothing here yet."}
        </p>
      ) : (
        groups.map((group) => (
          <div key={group.key} className="compact-mail-group">
            {group.label ? (
              <h2>
                <span>{group.label}</span>
                <em className="tabular">{group.rows.length}</em>
                <small>{group.hint}</small>
                {group.key === "delete" || group.key === "archive" ? (
                  <button
                    type="button"
                    onClick={() =>
                      void sweep(
                        group.rows,
                        group.key === "delete"
                          ? triageDeleteCommand
                          : triageArchiveCommand,
                      )
                    }
                  >
                    {group.key === "delete" ? "Delete all" : "Archive all"}
                  </button>
                ) : null}
              </h2>
            ) : null}
            {group.rows.map(renderRow)}
          </div>
        ))
      )}
      {matterRow ? (
        <div
          className="matter-picker-backdrop"
          role="presentation"
          onPointerDown={(event) => {
            if (event.target === event.currentTarget) setMatterRow(null);
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
                <h2 id="matter-picker-title">Put on Atlas</h2>
                <p>{matterRow.subject || "(no subject)"}</p>
              </div>
              <button
                type="button"
                aria-label="Close matter picker"
                onClick={() => setMatterRow(null)}
              >
                <X aria-hidden />
              </button>
            </header>

            <button
              type="button"
              className="matter-picker-ai"
              onClick={() => placeOnMatter(matterRow)}
            >
              <Sparkles aria-hidden />
              <span>
                <strong>Let Seer place it</strong>
                <small>Reuse a related matter, or create the right one.</small>
              </span>
            </button>

            {matterChoicesLoading ? (
              <p className="matter-picker-status">Sweeping Atlas for related work…</p>
            ) : matterChoices.length > 0 ? (
              <div className="matter-picker-list">
                {matterChoices.slice(0, 12).map((matter) => (
                  <button
                    key={matter.matterId}
                    type="button"
                    data-related={matter.related ? "true" : undefined}
                    onClick={() =>
                      placeOnMatter(matterRow, {
                        matterId: matter.matterId,
                      })
                    }
                  >
                    <span>{matter.shortTitle}</span>
                    <small>
                      {matter.related ? "Suggested by Seer" : matter.section ?? "Atlas"}
                    </small>
                  </button>
                ))}
              </div>
            ) : null}

            <form
              className="matter-picker-new"
              onSubmit={(event) => {
                event.preventDefault();
                const title = newMatterTitle.trim();
                if (!title) return;
                placeOnMatter(matterRow, {
                  matterTitle: title,
                  createMatter: true,
                });
              }}
            >
              <label htmlFor="new-matter-title">New matter</label>
              <div>
                <input
                  id="new-matter-title"
                  value={newMatterTitle}
                  maxLength={120}
                  onChange={(event) => setNewMatterTitle(event.target.value)}
                />
                <button type="submit" disabled={!newMatterTitle.trim()}>
                  Create
                </button>
              </div>
            </form>
          </section>
        </div>
      ) : null}
    </section>
  );
}
