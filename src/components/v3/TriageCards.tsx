"use client";

import * as React from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Archive, RotateCcw, Trash2 } from "lucide-react";
import type { Command } from "@/lib/v2/commands/types";
import type { MailboxRow } from "@/lib/v3/mailbox/types";
import {
  commandForVerdict,
  currentCard,
  deckFrom,
  decide,
  isFinished,
  reconcile,
  undoLast,
  upcoming,
  wouldDelete,
  type DeckState,
  type DeckVerdict,
} from "./triage-deck";

/**
 * Triage as a deck.
 *
 * The list makes you decide what to look at before you decide what to do, and
 * over four hundred rows that first decision is the expensive one. A deck takes
 * it away: the next card is simply the next card, and a verdict costs one
 * gesture. Swipe right to keep it, left to clear it — and "clear" is archive
 * unless the server authorized a delete, so the fast gesture can never reach
 * further than the button would.
 */

const COMMIT_PX = 120;

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

  // New mail arriving must not deal a card the user already decided, nor lose
  // their place in the queue.
  useEffect(() => {
    setDeck((previous) => reconcile(previous, rows));
  }, [rows]);

  const card = currentCard(deck);
  const behind = useMemo(() => upcoming(deck), [deck]);
  const total = deck.queue.length;

  const commit = useCallback(
    (verdict: DeckVerdict) => {
      const row = currentCard(deck);
      if (!row) return;
      setDragX(0);
      setDeck((previous) => decide(previous, verdict));
      const command = commandForVerdict(row, verdict);
      if (command) void onCommands([{ command, conversationId: row.conversationId }]);
    },
    [deck, onCommands],
  );

  // Direction lock: a card only moves when the drag is deliberately sideways,
  // so triaging never fights the scroll of the page underneath.
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
    if (dx > COMMIT_PX) return commit("keep");
    if (dx < -COMMIT_PX) return commit("delete");
    setDragX(0);
  };

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "ArrowRight") commit("keep");
      else if (event.key === "ArrowLeft") commit("delete");
      else if (event.key === "e") commit("archive");
      else if (event.key === "Escape") onExit();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [commit, onExit]);

  if (isFinished(deck) || !card) {
    return (
      <section className="deck-done" aria-live="polite">
        <p className="deck-done-line">
          {deck.decided > 0
            ? `${deck.decided} decided. Nothing left in this pile.`
            : "Nothing to triage."}
        </p>
        <div className="deck-actions">
          {deck.last && (
            <button type="button" className="deck-btn" onClick={() => setDeck(undoLast)}>
              <RotateCcw aria-hidden className="deck-icon" /> Undo
            </button>
          )}
          <button type="button" className="deck-btn deck-btn-primary" onClick={onExit}>
            Back to the list
          </button>
        </div>
      </section>
    );
  }

  const clearing = dragX < -20;
  const keeping = dragX > 20;
  const destructive = wouldDelete(card);

  return (
    <section className="deck" aria-label="Triage">
      <header className="deck-head">
        <span className="deck-count tabular">
          {deck.index + 1} of {total}
        </span>
        <button type="button" className="deck-exit" onClick={onExit}>
          List
        </button>
      </header>

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
          {/* What the gesture will do, named before it happens. */}
          <span className="deck-verdict deck-verdict-clear" data-on={clearing}>
            {destructive ? "Delete" : "Archive"}
          </span>
          <span className="deck-verdict deck-verdict-keep" data-on={keeping}>
            Keep
          </span>
          <button type="button" className="deck-open" onClick={() => onOpen(card)}>
            <CardFace row={card} />
          </button>
        </div>
      </div>

      <div className="deck-actions">
        <button
          type="button"
          className="deck-btn"
          onClick={() => commit("delete")}
          title={
            destructive
              ? "Delete this conversation"
              : "Seer did not clear this for deletion, so it will be archived"
          }
        >
          <Trash2 aria-hidden className="deck-icon" />
          {destructive ? "Delete" : "Archive"}
        </button>
        <button type="button" className="deck-btn" onClick={() => commit("archive")}>
          <Archive aria-hidden className="deck-icon" /> Archive
        </button>
        <button
          type="button"
          className="deck-btn deck-btn-primary"
          onClick={() => commit("keep")}
        >
          Keep
        </button>
        {deck.last && (
          <button type="button" className="deck-btn" onClick={() => setDeck(undoLast)}>
            <RotateCcw aria-hidden className="deck-icon" /> Undo
          </button>
        )}
      </div>
    </section>
  );
}

function CardFace({ row }: { row: MailboxRow }) {
  return (
    <div className="deck-face">
      <div className="deck-face-top">
        <span className="deck-sender">{row.senderDisplayName || "Unknown sender"}</span>
        {row.category && <span className="deck-cat tabular">{row.category}</span>}
      </div>
      <h2 className="deck-subject">{row.subject || "(no subject)"}</h2>
      {row.decisionSummary && <p className="deck-why">{row.decisionSummary}</p>}
      {row.snippet && <p className="deck-snippet">{row.snippet}</p>}
      <div className="deck-face-foot">
        {row.attachments.length > 0 && (
          <span className="tabular">
            {row.attachments.length} file{row.attachments.length === 1 ? "" : "s"}
          </span>
        )}
        {!row.deleteToken && (
          // The reason this one is not simply clearable, said on the card.
          <span className="deck-held">Held back — not cleared for deletion</span>
        )}
      </div>
    </div>
  );
}
