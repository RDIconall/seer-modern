"use client";

import * as React from "react";
import { useMemo, useState } from "react";
import type { Command } from "@/lib/v2/commands/types";
import type { MailboxRow, MailboxView } from "@/lib/v3/mailbox/types";

const when = (iso: string) => {
  const date = new Date(iso);
  return Number.isNaN(date.getTime())
    ? ""
    : date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
};

export function TriageTable({
  view,
  onCommands,
  onOpen,
  onPiles,
  onCards,
}: {
  view: MailboxView;
  onCommands: (commands: Command[]) => Promise<unknown>;
  onOpen: (row: MailboxRow) => void;
  onPiles: () => void;
  onCards?: () => void;
}) {
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const groups = useMemo(() => {
    const grouped = new Map<string, MailboxRow[]>();
    for (const row of view.rows) {
      const name = row.category?.trim() || "Other";
      grouped.set(name, [...(grouped.get(name) ?? []), row]);
    }
    return [...grouped.entries()];
  }, [view.rows]);

  const selectedRows = view.rows.filter((row) =>
    selected.has(row.conversationId),
  );
  const allSelected =
    view.rows.length > 0 && selected.size === view.rows.length;

  const toggle = (id: string) =>
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const run = async (commands: Command[]) => {
    if (commands.length === 0) return;
    await onCommands(commands);
    setSelected(new Set());
  };

  return (
    <section className="triage-table-shell" aria-labelledby="triage-table-title">
      <header className="triage-table-head">
        <div>
          <h1 id="triage-table-title">Triage</h1>
          <p>
            {view.total} conversations · {view.needsYou} need you
          </p>
        </div>
        <div className="triage-view-toggle" role="group" aria-label="Triage view">
          <button type="button" aria-pressed="true">
            Table
          </button>
          <button type="button" aria-pressed="false" onClick={onPiles}>
            Piles
          </button>
          <button type="button" onClick={onCards}>
            Cards
          </button>
        </div>
      </header>

      {selectedRows.length > 0 ? (
        <div className="triage-table-bulk" role="toolbar" aria-label="Selected mail">
          <strong>{selectedRows.length} selected</strong>
          <button
            type="button"
            onClick={() =>
              void run(
                selectedRows.map((row) => ({
                  type: "archive",
                  conversationId: row.conversationId,
                })),
              )
            }
          >
            Archive
          </button>
          <button
            type="button"
            onClick={() =>
              void run(
                selectedRows.map((row) => ({
                  type: "delete",
                  conversationId: row.conversationId,
                  byUser: true,
                })),
              )
            }
          >
            Delete
          </button>
        </div>
      ) : null}

      <div className="triage-table-scroll">
        <table className="triage-table">
          <colgroup>
            <col className="triage-table-check" />
            <col className="triage-table-from" />
            <col className="triage-table-subject" />
            <col className="triage-table-read" />
            <col className="triage-table-when" />
            <col className="triage-table-actions" />
          </colgroup>
          <thead>
            <tr>
              <th>
                <input
                  type="checkbox"
                  aria-label="Select all conversations"
                  checked={allSelected}
                  onChange={() =>
                    setSelected(
                      allSelected
                        ? new Set()
                        : new Set(view.rows.map((row) => row.conversationId)),
                    )
                  }
                />
              </th>
              <th>From</th>
              <th>Subject</th>
              <th>Seer&apos;s read</th>
              <th>When</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {groups.map(([category, rows]) => (
              <React.Fragment key={category}>
                <tr className="triage-table-group">
                  <th colSpan={6}>
                    {category} <span>{rows.length}</span>
                  </th>
                </tr>
                {rows.map((row) => (
                  <tr
                    key={row.conversationId}
                    className={row.isUnread ? "triage-table-unread" : undefined}
                    onClick={() => onOpen(row)}
                  >
                    <td onClick={(event) => event.stopPropagation()}>
                      <input
                        type="checkbox"
                        aria-label={`Select ${row.subject}`}
                        checked={selected.has(row.conversationId)}
                        onChange={() => toggle(row.conversationId)}
                      />
                    </td>
                    <td>{row.senderDisplayName || "Unknown sender"}</td>
                    <td>
                      <strong>{row.subject || "(no subject)"}</strong>
                      {row.attachments.length > 0 ? (
                        <span className="triage-table-files">
                          {row.attachments.length} file
                          {row.attachments.length === 1 ? "" : "s"}
                        </span>
                      ) : null}
                    </td>
                    <td>{row.decisionSummary || row.snippet}</td>
                    <td className="tabular">{when(row.timestamp)}</td>
                    <td
                      className="triage-table-row-actions"
                      onClick={(event) => event.stopPropagation()}
                    >
                      <button
                        type="button"
                        onClick={() =>
                          void run([
                            {
                              type: "archive",
                              conversationId: row.conversationId,
                            },
                          ])
                        }
                      >
                        Archive
                      </button>
                      <button
                        type="button"
                        onClick={() =>
                          void run([
                            {
                              type: "delete",
                              conversationId: row.conversationId,
                              byUser: true,
                            },
                          ])
                        }
                      >
                        Delete
                      </button>
                      <button
                        type="button"
                        onClick={() =>
                          void run([
                            {
                              type: "correctConversation",
                              conversationId: row.conversationId,
                              home: "matter",
                              note: "kept in triage",
                            },
                          ])
                        }
                      >
                        Keep
                      </button>
                    </td>
                  </tr>
                ))}
              </React.Fragment>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
