"use client";

import * as React from "react";
import { useMemo, useState } from "react";
import type { Command, CommandResult } from "@/lib/v2/commands/types";
import type { MailboxRow, MailboxView } from "@/lib/v3/mailbox/types";
import { triagePiles } from "@/lib/v3/mailbox/triage-verb";
import { MobileMailRow } from "./MobileMailRow";

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
const matterCommand = (row: MailboxRow): Command => ({
  type: "correctConversation",
  conversationId: row.conversationId,
  home: "matter",
  note: "made a matter in triage",
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

  const act = async (row: MailboxRow, command: Command) => {
    setHidden((current) => new Set(current).add(row.conversationId));
    try {
      await onCommands([command]);
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

  const sweep = (groupRows: MailboxRow[], command: (row: MailboxRow) => Command) => {
    setHidden((current) => {
      const next = new Set(current);
      for (const row of groupRows) next.add(row.conversationId);
      return next;
    });
    void onCommands(groupRows.map(command));
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
      onArchive={() => void act(row, archiveCommand(row))}
      onDelete={() => void act(row, deleteCommand(row))}
      actions={
        triage
          ? [
              { label: "Atlas", run: () => void act(row, matterCommand(row)) },
              { label: "Archive", run: () => void act(row, archiveCommand(row)) },
              { label: "Delete", run: () => void act(row, deleteCommand(row)) },
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
              ? `${rows.length} to place · Atlas, archive or bin`
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
                      sweep(
                        group.rows,
                        group.key === "delete" ? deleteCommand : archiveCommand,
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
    </section>
  );
}
