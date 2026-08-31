"use client";

import * as React from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Archive, Check, RotateCcw, Trash2, X } from "lucide-react";
import type { Command } from "@/lib/v2/commands/types";
import type { IrrelevanceReason } from "@/lib/v2/intelligence/mailbox-style";
import type { MailboxRow } from "@/lib/v3/mailbox/types";
import {
  commandForRelevance,
  commandForVerdict,
  currentCard,
  deckFrom,
  decide,
  isFinished,
  reconcile,
  undoLast,
  upcoming,
  type DeckState,
  type DeckVerdict,
} from "./triage-deck";

const COMMIT_PX = 120;

const WHY: { id: IrrelevanceReason; label: string; hint: string }[] = [
  { id: "taken_care_of", label: "Taken care of", hint: "Done — keep findable" },
  { id: "ended", label: "It ended", hint: "The work is finished" },
  { id: "never_was", label: "Never was", hint: "Not live work" },
  { id: "not_for_me", label: "Not for me", hint: "FYI or wrong desk" },
];

export function TriageCards({
  rows,
  onCommands,
  onOpen,
  onExit,
}: {
  rows: MailboxRow[];
  onCommands: (commands: { command: Command; conversationId: string }[]) => Promise<void>;
  onOpen: (row: MailboxRow) => void;
  onExit: () => void;
}) {
  const [deck, setDeck] = useState<DeckState>(() => deckFrom(rows));
  const [dragX, setDragX] = useState(0);
  const [dragging, setDragging] = useState(false);
  const [whyOpen, setWhyOpen] = useState(false);

  useEffect(() => {
    setDeck((previous) => reconcile(previous, rows));
  }, [rows]);

  const card = currentCard(deck);
  const behind = useMemo(() => upcoming(deck), [deck]);
  const total = deck.queue.length;

  const commitRelevance = useCallback(
    (relevant: boolean, reason?: IrrelevanceReason | null) => {
      const row = currentCard(deck);
      if (!row) return;
      setDragX(0);
      setWhyOpen(false);
      setDeck((previous) => decide(previous, relevant ? "matter" : "archive"));
      const command = commandForRelevance(row, relevant, reason);
      void onCommands([{ command, conversationId: row.conversationId }]);
    },
    [deck, onCommands],
  );

  const commit = useCallback(
    (verdict: DeckVerdict) => {
      const row = currentCard(deck);
      if (!row) return;
      setDragX(0);
      setWhyOpen(false);
      setDeck((previous) => decide(previous, verdict));
      const command = commandForVerdict(row, verdict);
      void onCommands([{ command, conversationId: row.conversationId }]);
    },
    [deck, onCommands],
  );

  const start = useRef<{ x: number; y: number } | null>(null);
  const horizontal = useRef<boolean | null>(null);

  const onPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    start.current = { x: event.clientX, y: event.clientY };
    horizontal.current = null;
    setDragging(true);
  };
  const onPointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!start.current) return;
    const dx = event.clientX - start.current.x;
    const dy = event.clientY - start.current.y;
    if (horizontal.current === null) {
      if (Math.abs(dx) < 14 && Math.abs(dy) < 14) return;
      horizontal.current = Math.abs(dx) > Math.abs(dy) * 1.6;
    }
    if (!horizontal.current) return;
    event.currentTarget.setPointerCapture?.(event.pointerId);
    setDragX(dx);
  };
  const endDrag = () => {
    const armed = horizontal.current;
    const dx = dragX;
    start.current = null;
    horizontal.current = null;
    setDragging(false);
    if (!armed) return setDragX(0);
    if (dx > COMMIT_PX) return commitRelevance(true);
    if (dx < -COMMIT_PX) {
      setDragX(0);
      setWhyOpen(true);
      return;
    }
    setDragX(0);
  };

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "ArrowRight" || event.key === "y") commitRelevance(true);
      else if (event.key === "ArrowLeft" || event.key === "n") setWhyOpen(true);
      else if (event.key === "e") commit("archive");
      else if (event.key === "Escape") onExit();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [commit, commitRelevance, onExit]);

  if (isFinished(deck) || !card) {
    return (
      <section className="deck deck-done seer-deck-bg" aria-live="polite">
        <p className="deck-done-line">
          {deck.decided > 0
            ? `${deck.decided} decided. Nothing left in this pile.`
            : "Nothing to triage."}
        </p>
        <div className="deck-actions">
          {deck.last && (
            <DeckAction label="Undo" onClick={() => setDeck(undoLast)}>
              <RotateCcw aria-hidden />
            </DeckAction>
          )}
          <DeckAction label="List" primary onClick={onExit}>
            <Check aria-hidden />
          </DeckAction>
        </div>
      </section>
    );
  }

  const clearing = dragX < -20;
  const keeping = dragX > 20;

  return (
    <section className="deck seer-deck-bg" aria-label="Cards">
      <header className="deck-head">
        <span className="deck-count tabular">
          {deck.index + 1} of {total}
        </span>
        <button type="button" className="deck-exit" onClick={onExit}>
          List
        </button>
      </header>

      <p className="deck-prompt">Is this still relevant?</p>

      <div className="deck-stage">
        {behind.map((row, depth) => (
          <article
            key={row.conversationId}
            className="deck-card deck-card-behind"
            style={{
              transform: `translateY(${(depth + 1) * 8}px) scale(${1 - (depth + 1) * 0.03})`,
              zIndex: 10 - depth,
            }}
            aria-hidden
          >
            <CardFace row={row} />
          </article>
        ))}

        <div
          className="deck-card deck-card-top"
          style={{
            transform: `translateX(${dragX}px) rotate(${dragX / 28}deg)`,
            transition: dragging ? "none" : "transform .2s ease",
          }}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
        >
          <span className="deck-verdict deck-verdict-clear" data-on={clearing}>
            Not relevant
          </span>
          <span className="deck-verdict deck-verdict-keep" data-on={keeping}>
            Still relevant
          </span>
          <button type="button" className="deck-open" onClick={() => onOpen(card)}>
            <CardFace row={card} />
          </button>
        </div>
      </div>

      {whyOpen ? (
        <div className="deck-why-sheet" role="group" aria-label="Why not relevant">
          <p className="deck-why-title">Why not?</p>
          {WHY.map((item) => (
            <button
              key={item.id}
              type="button"
              className="deck-why-option"
              onClick={() => commitRelevance(false, item.id)}
            >
              <span>{item.label}</span>
              <span className="deck-why-hint">{item.hint}</span>
            </button>
          ))}
          <button type="button" className="deck-why-cancel" onClick={() => setWhyOpen(false)}>
            Cancel
          </button>
        </div>
      ) : (
        <div className="deck-actions">
          <DeckAction label="No" onClick={() => setWhyOpen(true)}>
            <X aria-hidden />
          </DeckAction>
          <DeckAction label="Yes" primary onClick={() => commitRelevance(true)}>
            <Check aria-hidden />
          </DeckAction>
          <DeckAction label="Archive" onClick={() => commit("archive")}>
            <Archive aria-hidden />
          </DeckAction>
          <DeckAction label="Delete" onClick={() => commit("delete")}>
            <Trash2 aria-hidden />
          </DeckAction>
          <DeckAction
            label="Undo"
            disabled={!deck.last}
            onClick={() => setDeck(undoLast)}
          >
            <RotateCcw aria-hidden />
          </DeckAction>
        </div>
      )}
    </section>
  );
}

function DeckAction({
  children,
  label,
  onClick,
  primary,
  disabled,
}: {
  children: React.ReactNode;
  label: string;
  onClick: () => void;
  primary?: boolean;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      className="deck-action"
      data-primary={primary ? "true" : undefined}
      disabled={disabled}
      onClick={onClick}
    >
      <span className="deck-action-ring">{children}</span>
      <span className="deck-action-label">{label}</span>
    </button>
  );
}

const initialOf = (name: string) => (name.trim()[0] ?? "?").toUpperCase();

function CardFace({ row }: { row: MailboxRow }) {
  const sender = row.senderDisplayName || "Unknown sender";
  return (
    <div className="seer-card-face deck-face">
      <div className="deck-face-top">
        <span className="deck-avatar" aria-hidden>
          {initialOf(sender)}
        </span>
        <span className="deck-who">
          <span className="deck-sender">{sender}</span>
          {row.category && <span className="deck-cat">{row.category}</span>}
        </span>
        <time className="deck-when tabular" dateTime={row.timestamp}>
          {row.timestamp ? new Date(row.timestamp).toLocaleDateString(undefined, {
            month: "short",
            day: "numeric",
          }) : ""}
        </time>
      </div>

      <div className="deck-face-middle">
        <h2 className="deck-subject">{row.subject || "(no subject)"}</h2>
        {row.decisionSummary && <p className="deck-why">{row.decisionSummary}</p>}
        {row.snippet && <p className="deck-snippet">{row.snippet}</p>}
      </div>

      <div className="deck-face-foot">
        {row.attachments.length > 0 && (
          <span className="tabular">
            {row.attachments.length} file{row.attachments.length === 1 ? "" : "s"}
          </span>
        )}
      </div>
    </div>
  );
}
