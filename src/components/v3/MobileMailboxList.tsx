"use client";

import * as React from "react";
import { useState } from "react";
import type { Command, CommandResult } from "@/lib/v2/commands/types";
import type { MailboxRow, MailboxView } from "@/lib/v3/mailbox/types";
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
}: {
  view: MailboxView;
  triage?: boolean;
  currentConversationId?: string | null;
  onOpen: (row: MailboxRow) => void;
  onCommands: (commands: Command[]) => Promise<CommandResult[]>;
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
  return (
    <section
      className="mobile-mail-list"
      aria-label={`${triage ? "Triage" : "Inbox"} messages`}
    >
      {rows.length === 0 ? (
        <p className="mail-empty">Nothing here yet.</p>
      ) : (
        rows.map((row) => (
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
              badge: triage ? row.category ?? undefined : undefined,
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
        ))
      )}
    </section>
  );
}
