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
            rows: pile.days.flatMap((day) => day.rows),
          }))
        : [{ key: view.folder, label: "", rows }],
    [rows, triage, view.folder],
  );

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
        void act(row, {
          type: "archive",
          conversationId: row.conversationId,
        })
      }
      onDelete={() =>
        void act(row, {
          type: "delete",
          conversationId: row.conversationId,
          byUser: true,
        })
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
              ? `${view.needsYou} need you · ${view.total - view.needsYou} sorted`
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
        <p className="mail-empty">Nothing here yet.</p>
      ) : (
        groups.map((group) => (
          <div key={group.key} className="compact-mail-group">
            {group.label ? (
              <h2>
                <span>{group.label}</span>
                <em className="tabular">{group.rows.length}</em>
              </h2>
            ) : null}
            {group.rows.map(renderRow)}
          </div>
        ))
      )}
    </section>
  );
}
