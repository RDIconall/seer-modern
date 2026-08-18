"use client";

import * as React from "react";
import { useMemo, useRef, useState } from "react";
import type { Command } from "@/lib/v2/commands/types";
import type { MailboxRow } from "@/lib/v3/mailbox/types";
import {
  timeLabel,
  triagePiles,
  type TriageVerb,
} from "@/lib/v3/mailbox/triage-verb";

/**
 * Triage.
 *
 * Four piles named after what you are about to do — delete it, file it, answer
 * it, keep it — with the mail's own days inside each. Seer does the grouping;
 * the dates belong to the mail, and neither is annotated at the other's expense.
 *
 * Every row leaves in one of four directions and only one ends on the board:
 * anything not deleted and not filed is live work, so Keep makes it a matter on
 * Atlas. That is the whole claim of the screen — triage is the mouth of Atlas,
 * not a bin with a bin next to it.
 */

/** Right past this files; a longer left pull deletes. */
const NEAR = 78;
const FAR = 176;

type Settled = { row: MailboxRow; what: string };

/** A row action must not also open the mail underneath it. */
const press =
  (act: () => void) => (event: React.MouseEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.stopPropagation();
    act();
  };

export function TriageList({
  rows,
  onCommands,
  onOpen,
}: {
  rows: MailboxRow[];
  onCommands: (commands: Command[]) => Promise<unknown>;
  onOpen: (row: MailboxRow) => void;
}) {
  const [settled, setSettled] = useState<Settled[]>([]);
  const settledIds = useMemo(
    () => new Set(settled.map((s) => s.row.conversationId)),
    [settled],
  );
  const piles = useMemo(() => triagePiles(rows, settledIds), [rows, settledIds]);

  const settle = (row: MailboxRow, what: string, command: Command) => {
    setSettled((prev) => [...prev, { row, what }]);
    void onCommands([command]);
  };

  const toAtlas = (row: MailboxRow) =>
    // Keeping it is a correction to Seer's reading, and corrections are law:
    // the conversation becomes a matter and shows up on the whiteboard.
    settle(row, "Atlas", {
      type: "correctConversation",
      conversationId: row.conversationId,
      home: "matter",
      note: "kept in triage",
    });

  const toFile = (row: MailboxRow) =>
    settle(row, "Filed", { type: "archive", conversationId: row.conversationId });

  const toTrash = (row: MailboxRow) =>
    settle(row, "Deleted", {
      type: "delete",
      conversationId: row.conversationId,
      byUser: true,
    });

  const undo = (row: MailboxRow) => {
    const entry = settled.find((s) => s.row.conversationId === row.conversationId);
    setSettled((prev) => prev.filter((s) => s.row.conversationId !== row.conversationId));
    if (!entry) return;
    // Deleting and filing both moved the mail, so putting it back is a restore.
    // Keeping it only changed Seer's mind, and there is nothing to fetch back.
    if (entry.what === "Deleted" || entry.what === "Filed") {
      void onCommands([{ type: "restore", conversationId: row.conversationId }]);
    }
  };

  const counted = (what: string) => settled.filter((s) => s.what === what).length;

  return (
    <section className="tri" aria-label="Triage">
      {piles.length === 0 ? (
        <div className="tri-end">
          <b>Clear</b>
          {counted("Deleted")} deleted · {counted("Filed")} filed ·{" "}
          {counted("Answered")} answered · {counted("Atlas")} to Atlas
        </div>
      ) : (
        piles.map((pile) => (
          <div key={pile.verb}>
            <h2 className="tri-g">
              {pile.label}
              <em className="tabular">{pile.count}</em>
            </h2>
            {pile.days.map((day) => (
              <div key={day.day}>
                <div className="tri-day tabular">{day.day}</div>
                <div className="tri-set">
                  {day.rows.map((row) => (
                    <TriageRow
                      key={row.conversationId}
                      row={row}
                      verb={pile.verb}
                      onOpen={() => onOpen(row)}
                      onAtlas={() => toAtlas(row)}
                      onFile={() => toFile(row)}
                      onTrash={() => toTrash(row)}
                    />
                  ))}
                </div>
              </div>
            ))}
          </div>
        ))
      )}

      {settled.length > 0 && (
        <div className="tri-set tri-settled">
          {settled.map((entry) => (
            <div key={entry.row.conversationId} className="tri-was tabular">
              <span>
                {entry.what} · {entry.row.senderDisplayName || "Unknown sender"}
              </span>
              <button type="button" onClick={() => undo(entry.row)}>
                Undo
              </button>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

function TriageRow({
  row,
  verb,
  onOpen,
  onAtlas,
  onFile,
  onTrash,
}: {
  row: MailboxRow;
  verb: TriageVerb;
  onOpen: () => void;
  onAtlas: () => void;
  onFile: () => void;
  onTrash: () => void;
}) {
  const [dx, setDx] = useState(0);
  const [sliding, setSliding] = useState(false);
  const start = useRef<{ x: number; y: number } | null>(null);
  const horizontal = useRef<boolean | null>(null);
  const moved = useRef(false);

  const far = dx <= -FAR;
  const time = timeLabel(row.timestamp);

  const onPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if ((event.target as HTMLElement).closest("button, textarea")) return;
    start.current = { x: event.clientX, y: event.clientY };
    horizontal.current = null;
    moved.current = false;
    setSliding(true);
  };
  const onPointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!start.current) return;
    const nextX = event.clientX - start.current.x;
    const nextY = event.clientY - start.current.y;
    if (horizontal.current === null) {
      if (Math.abs(nextX) < 10 && Math.abs(nextY) < 10) return;
      horizontal.current = Math.abs(nextX) > Math.abs(nextY) * 1.4;
    }
    if (!horizontal.current) return;
    moved.current = true;
    event.currentTarget.setPointerCapture?.(event.pointerId);
    setDx(nextX);
  };
  const end = () => {
    if (!start.current && !moved.current) return;
    const travelled = dx;
    start.current = null;
    horizontal.current = null;
    setSliding(false);
    setDx(0);
    if (travelled > NEAR) return onAtlas();
    if (travelled <= -FAR) return onTrash();
    if (travelled <= -NEAR) return onFile();
  };

  return (
    <div className="tri-r" data-far={far ? "true" : undefined}>
      {/* What the pull will do, named before it commits. */}
      <div className="tri-rev tabular">
        <span className="tri-rev-keep">ATLAS</span>
        <span className="tri-rev-drop">{far ? "DELETE" : "ARCHIVE"}</span>
      </div>
      <div
        className="tri-in"
        style={{
          transform: `translateX(${dx}px)`,
          transition: sliding ? "none" : "transform .2s ease",
        }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={end}
        onPointerCancel={end}
        onClick={(event) => {
          if (moved.current) {
            event.preventDefault();
            event.stopPropagation();
            moved.current = false;
            return;
          }
          onOpen();
        }}
      >
        <div className="tri-l1">
          {row.isUnread && <span className="tri-dot" aria-hidden />}
          <span className={`tri-from${row.isUnread ? "" : " tri-read"}`}>
            {row.senderDisplayName || "Unknown sender"}
          </span>
          <span className="tri-when tabular">{time || "—"}</span>
        </div>
        <div className={`tri-subj${row.isUnread ? "" : " tri-read"}`}>
          {row.subject || "(no subject)"}
        </div>
        <div className="tri-snip">{row.decisionSummary || row.snippet || ""}</div>
        {(row.attachments.length > 0 || verb === "answer") && (
          <div className="tri-clip tabular">
            {row.attachments.length > 0
              ? `${row.attachments.length} attachment${row.attachments.length === 1 ? "" : "s"}`
              : "You owe a reply"}
          </div>
        )}
        {/* The same four directions as the pull, said in words. A pointer has no
            swipe, and deleting your own mail should never depend on a gesture. */}
        <div className="tri-do">
          <button type="button" className="tri-do-b" onClick={press(onAtlas)}>
            Keep
          </button>
          <button type="button" className="tri-do-b" onClick={press(onFile)}>
            File
          </button>
          <button
            type="button"
            className="tri-do-b tri-do-del"
            onClick={press(onTrash)}
          >
            Delete
          </button>
        </div>
      </div>
    </div>
  );
}
