"use client";

import { useEffect, useState } from "react";
import { Archive, RotateCcw } from "lucide-react";
import type { MailboxRow, MailboxView } from "@/lib/v3/mailbox/types";
import { rowLabel } from "./useMailbox";

function shortTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat([], { month: "short", day: "numeric" }).format(date);
}

export function FolderList({
  view,
  refreshing,
  onOpen,
  onPrefetch,
  onAction,
}: {
  view: MailboxView;
  refreshing: boolean;
  onOpen: (row: MailboxRow) => void;
  onPrefetch: (conversationId: string) => void;
  onAction: (row: MailboxRow, action: "archive" | "restore") => void;
}) {
  const actionLabel = view.folder === "trash" ? "Restore" : "Archive";
  const ActionIcon = view.folder === "trash" ? RotateCcw : Archive;
  const [selected, setSelected] = useState<Set<string>>(new Set());

  useEffect(() => {
    setSelected((current) => {
      const live = new Set(view.rows.map((row) => row.conversationId));
      return new Set([...current].filter((id) => live.has(id)));
    });
  }, [view.rows]);

  const toggle = (id: string) => {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const bulkAction = () => {
    for (const row of view.rows) {
      if (selected.has(row.conversationId)) onAction(row, view.folder === "trash" ? "restore" : "archive");
    }
    setSelected(new Set());
  };

  return (
    <section className="mail-folder-layout" aria-label={`${view.folder} messages`}>
      <header className="mail-list-header">
        <div>
          <h1>{view.folder[0].toUpperCase() + view.folder.slice(1)}</h1>
          <p>
            {view.total} {view.total === 1 ? "conversation" : "conversations"}
            {refreshing ? " · Updating…" : ""}
          </p>
        </div>
        {selected.size > 0 && (
          <div className="mail-list-selection" role="toolbar" aria-label="Selected message actions">
            <span>{selected.size} selected</span>
            <button type="button" className="mail-action mail-focus-ring" onClick={bulkAction}>
              {actionLabel}
            </button>
          </div>
        )}
      </header>

      {view.rows.length === 0 ? (
        <p className="mail-empty">Nothing here yet.</p>
      ) : (
        <ul className="mail-list">
          {view.rows.map((row) => {
            const checked = selected.has(row.conversationId);
            return (
              <li
                key={row.conversationId}
                className="mail-list-row"
                data-unread={row.isUnread ? "true" : "false"}
              >
                <input
                  type="checkbox"
                  className="mail-list-checkbox mail-focus-ring"
                  checked={checked}
                  aria-label={`Select ${rowLabel(row)}`}
                  onChange={() => toggle(row.conversationId)}
                />
                <button
                  type="button"
                  className="mail-list-open mail-focus-ring"
                  aria-label={`Open ${rowLabel(row)}`}
                  onClick={() => onOpen(row)}
                  onFocus={() => onPrefetch(row.conversationId)}
                  onMouseEnter={() => onPrefetch(row.conversationId)}
                >
                  <span className="mail-list-main">
                    <span className="mail-list-sender">{row.senderDisplayName || "Unknown sender"}</span>
                    <span className="mail-list-subject">{row.subject || "(no subject)"}</span>
                    <span className="mail-list-snippet">{row.snippet || "No preview available"}</span>
                  </span>
                  <span className="mail-list-meta">
                    <time dateTime={row.timestamp}>{shortTime(row.timestamp)}</time>
                    {row.attachments.length > 0 && (
                      <span aria-label={`${row.attachments.length} attachments`}>
                        · {row.attachments.length} file{row.attachments.length === 1 ? "" : "s"}
                      </span>
                    )}
                  </span>
                </button>
                {view.folder !== "sent" && (
                  <button
                    type="button"
                    className="mail-action mail-list-action mail-focus-ring"
                    aria-label={`${actionLabel} ${row.subject || "conversation"}`}
                    title={actionLabel}
                    onClick={() => onAction(row, view.folder === "trash" ? "restore" : "archive")}
                  >
                    <ActionIcon aria-hidden />
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
