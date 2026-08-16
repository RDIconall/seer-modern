"use client";

import * as React from "react";
import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, ChevronRight, X } from "lucide-react";
import type {
  ConversationRow,
  InboxView,
  MatterCard,
} from "@/lib/v2/view/types";

/**
 * ATLAS — the whiteboard.
 *
 * The board is organised by SECTION: the part of the business, not the
 * counterparty. That is the axis the user's own whiteboard uses, and it is why
 * a matter carries a section as well as an org unit — "Roche stability fixes"
 * belongs beside the other engineering work, not beside the Roche invoice.
 *
 * A matter is a line, not a card. The title carries it; who holds it and how
 * long it has sat are set small beside it, so a section reads as a column of
 * work rather than a stack of boxes. One matter stands open at a time, and its
 * expansion says only what the title cannot: the next action, and the buttons
 * that discharge it.
 *
 * Work that is with someone else and has stopped moving is parked into a single
 * line — no decision is waiting on you — while everything of yours stays on the
 * board however old it is.
 */

/**
 * Section names are shown exactly as the registry holds them. They are the
 * user's own headings — "sales — leads", "hr", "systems (it)" — and title-casing
 * turns "hr" into "Hr", which is not what anyone wrote on a whiteboard.
 */
function sectionLabel(name: string): string {
  return name === "unfiled" ? "unfiled" : name;
}

/** A matter has not moved since its most recent conversation did. */
function daysSinceMoved(matter: MatterCard, now: number): number {
  let latest = 0;
  for (const conversation of matter.conversations) {
    const at = conversation.at ? Date.parse(conversation.at) : NaN;
    if (!Number.isNaN(at) && at > latest) latest = at;
  }
  if (latest === 0) return 0;
  return Math.max(0, Math.floor((now - latest) / 86_400_000));
}

/**
 * A week is the line between "in flight" and "stalled". Under it, silence is
 * just the normal gap between replies; over it, nobody is coming back to this
 * on their own.
 */
const STALE_DAYS = 7;

const isYours = (matter: MatterCard) => matter.owner === "you";

/**
 * Who to chase. The owner field is a role, not a person, so for work that sits
 * with someone else the most recent sender is the name worth showing — "Nudge
 * Lara" is actionable in a way that "Nudge them" is not.
 */
function ownerLabel(matter: MatterCard): string {
  if (matter.owner === "you") return "You";
  let latest = 0;
  let name = "";
  for (const conversation of matter.conversations) {
    const at = conversation.at ? Date.parse(conversation.at) : NaN;
    if (!Number.isNaN(at) && at >= latest && conversation.from) {
      latest = at;
      name = conversation.from;
    }
  }
  const first = name.split(/[\s,]+/)[0] ?? "";
  if (first) return first;
  if (matter.owner === "team") return "Team";
  if (matter.owner === "them") return "Them";
  return "—";
}

/**
 * Work that is with someone else and has stopped moving is parked: there is no
 * decision waiting on you, so it rolls into a single line and stays out of the
 * way until asked for. Everything yours stays on the board however old it is.
 */
const isParked = (matter: MatterCard, now: number) =>
  !isYours(matter) && daysSinceMoved(matter, now) > STALE_DAYS;

export function Atlas({
  view,
  onArchiveMatter,
  onReplyMatter,
  onForwardMatter,
  onOpenConversation,
}: {
  view: InboxView;
  onArchiveMatter?: (matter: MatterCard) => void | Promise<unknown>;
  onReplyMatter?: (matter: MatterCard) => void;
  onForwardMatter?: (matter: MatterCard) => void;
  onOpenConversation?: (conversation: ConversationRow) => void;
}) {
  const [selectedMatterId, setSelectedMatterId] = useState<string | null>(null);
  // Only "mine" narrows the board, and only one matter stands open: the board
  // answers "what is the state of the business", and two open answers is a list.
  const [mineOnly, setMineOnly] = useState(false);
  const [openMatterId, setOpenMatterId] = useState<string | null>(null);
  const [openRolls, setOpenRolls] = useState<ReadonlySet<string>>(new Set());
  const [archived, setArchived] = useState<ReadonlySet<string>>(new Set());
  const [undoable, setUndoable] = useState<ReadonlySet<string>>(new Set());
  const undoTimers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const sections = view.sections;

  useEffect(() => {
    const timers = undoTimers.current;
    return () => {
      for (const timer of timers.values()) clearTimeout(timer);
      timers.clear();
    };
  }, []);

  // The board's shape is recomputed once per render pass, not per row: with a
  // hundred matters the age of each is asked for several times over.
  const now = Date.now();
  const shaped = useMemo(
    () =>
      sections.map((section) => {
        const visible = section.matters.filter(
          (matter) => !archived.has(matter.matterId) || undoable.has(matter.matterId),
        );
        const kept = visible.filter((matter) => !mineOnly || isYours(matter));
        return {
          name: section.name,
          matters: kept.filter((matter) => !isParked(matter, now)),
          parked: mineOnly ? [] : kept.filter((matter) => isParked(matter, now)),
        };
      }),
    // `now` is deliberately excluded: it changes every render and ages move by
    // the day, not the frame.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [sections, mineOnly, archived, undoable],
  );

  const live = useMemo(
    () =>
      sections
        .flatMap((section) => section.matters)
        .filter((matter) => !archived.has(matter.matterId)),
    [sections, archived],
  );
  const yours = live.filter(isYours).length;
  const stalled = live.filter((matter) => daysSinceMoved(matter, now) > STALE_DAYS).length;

  const archive = (matter: MatterCard) => {
    setOpenMatterId(null);
    setArchived((prev) => new Set(prev).add(matter.matterId));
    setUndoable((prev) => new Set(prev).add(matter.matterId));
    void onArchiveMatter?.(matter);
    const existing = undoTimers.current.get(matter.matterId);
    if (existing) clearTimeout(existing);
    undoTimers.current.set(
      matter.matterId,
      setTimeout(() => {
        undoTimers.current.delete(matter.matterId);
        setUndoable((prev) => {
          const next = new Set(prev);
          next.delete(matter.matterId);
          return next;
        });
      }, 5000),
    );
  };

  const undo = (matter: MatterCard) => {
    const timer = undoTimers.current.get(matter.matterId);
    if (timer) clearTimeout(timer);
    undoTimers.current.delete(matter.matterId);
    setArchived((prev) => {
      const next = new Set(prev);
      next.delete(matter.matterId);
      return next;
    });
    setUndoable((prev) => {
      const next = new Set(prev);
      next.delete(matter.matterId);
      return next;
    });
  };

  if (sections.length === 0) {
    return (
      <section className="wb-empty" aria-label="Atlas — the whiteboard">
        No live matters yet.
      </section>
    );
  }

  const shown = shaped.reduce(
    (n, section) => n + section.matters.length + section.parked.length,
    0,
  );

  return (
    <section aria-label="Atlas — the whiteboard" className="wb">
      <header className="wb-head">
        <h1 className="wb-title">Whiteboard</h1>
        <p className="wb-ledger tabular">
          {yours} yours · {live.length - yours} out
          {stalled > 0 ? (
            <>
              {" · "}
              <span className="wb-stale">{stalled} stalled</span>
            </>
          ) : null}
        </p>
        <div className="wb-seg" role="group" aria-label="Filter the board">
          <button type="button" aria-pressed={!mineOnly} onClick={() => setMineOnly(false)}>
            All
          </button>
          <button type="button" aria-pressed={mineOnly} onClick={() => setMineOnly(true)}>
            Mine
          </button>
        </div>
      </header>

      {shown === 0 ? (
        <p className="wb-empty">Nothing is yours right now.</p>
      ) : (
        shaped.map((section) => {
          if (section.matters.length === 0 && section.parked.length === 0) return null;
          const sectionStale = section.matters.filter(
            (matter) => daysSinceMoved(matter, now) > STALE_DAYS,
          ).length;
          const rollOpen = openRolls.has(section.name);
          return (
            <div key={section.name}>
              <div className="wb-shead">
                <span className="wb-sname atlas-heading">{sectionLabel(section.name)}</span>
                <span className="wb-scount tabular">
                  {section.matters.length}
                  {section.parked.length > 0 ? ` + ${section.parked.length}` : ""}
                  {sectionStale > 0 ? (
                    <>
                      {" · "}
                      <span className="wb-stale">{sectionStale} stalled</span>
                    </>
                  ) : null}
                </span>
              </div>
              <div className="wb-sec">
                {section.matters.map((matter) => (
                  <BoardMatter
                    key={matter.matterId}
                    matter={matter}
                    now={now}
                    open={openMatterId === matter.matterId}
                    archived={archived.has(matter.matterId)}
                    onToggle={() =>
                      setOpenMatterId((current) =>
                        current === matter.matterId ? null : matter.matterId,
                      )
                    }
                    onArchive={() => archive(matter)}
                    onUndo={() => undo(matter)}
                    onReply={onReplyMatter ? () => onReplyMatter(matter) : undefined}
                    onForward={onForwardMatter ? () => onForwardMatter(matter) : undefined}
                    onOpenMatter={() => setSelectedMatterId(matter.matterId)}
                  />
                ))}
                {section.parked.length > 0 && (
                  <div className="wb-roll">
                    <button
                      type="button"
                      className="wb-rollhead"
                      aria-expanded={rollOpen}
                      onClick={() =>
                        setOpenRolls((prev) => {
                          const next = new Set(prev);
                          if (next.has(section.name)) next.delete(section.name);
                          else next.add(section.name);
                          return next;
                        })
                      }
                    >
                      <Chevron open={rollOpen} />
                      <span className="wb-mt">Parked</span>
                      <span className="wb-own tabular">{section.parked.length}</span>
                    </button>
                    {rollOpen && (
                      <div className="wb-rlist">
                        {section.parked.map((matter) => (
                          <button
                            key={matter.matterId}
                            type="button"
                            className="wb-rrow"
                            onClick={() => setSelectedMatterId(matter.matterId)}
                          >
                            <span>{matter.shortTitle}</span>
                            <span className="tabular">{daysSinceMoved(matter, now)}d</span>
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                )}
              </div>
            </div>
          );
        })
      )}

      <p className="wb-foot tabular">
        {`Accounted ${view.coverage.read} of ${view.coverage.providerTotal}`}
        {view.coverage.pending > 0 ? `\n${view.coverage.pending} still reading` : ""}
      </p>

      {selectedMatterId &&
        (() => {
          const matter = view.atlas.find((item) => item.matterId === selectedMatterId);
          return matter ? (
            <MatterDetail
              matter={matter}
              onClose={() => setSelectedMatterId(null)}
              onOpenConversation={onOpenConversation}
            />
          ) : null;
        })()}
    </section>
  );
}

/* --------------------------------------------------------------- Matter --- */

/**
 * One line on the whiteboard. The title carries the matter; who has it and how
 * long it has sat are set small and to the right. Opening it shows only what
 * the title cannot say — the next action, and the actions that discharge it.
 */
function BoardMatter({
  matter,
  now,
  open,
  archived,
  onToggle,
  onArchive,
  onUndo,
  onReply,
  onForward,
  onOpenMatter,
}: {
  matter: MatterCard;
  now: number;
  open: boolean;
  archived: boolean;
  onToggle: () => void;
  onArchive: () => void;
  onUndo: () => void;
  onReply?: () => void;
  onForward?: () => void;
  onOpenMatter: () => void;
}) {
  const age = daysSinceMoved(matter, now);
  const stale = age > STALE_DAYS;
  const owner = ownerLabel(matter);
  const yours = isYours(matter);

  return (
    <div
      className={`wb-m${open ? " wb-m-open" : ""}${archived ? " wb-m-gone" : ""}`}
    >
      <button
        type="button"
        className="wb-mhead"
        aria-expanded={archived ? undefined : open}
        onClick={archived ? undefined : onToggle}
        disabled={archived}
      >
        {!archived && <Chevron open={open} />}
        <span className="wb-mt">{matter.shortTitle}</span>
        <span className={`wb-own tabular${yours ? " wb-own-you" : ""}`}>
          {owner}
          {stale ? <span className="wb-stale">{` ${age}d`}</span> : null}
        </span>
      </button>

      {archived ? (
        <div className="wb-undo tabular">
          <span>Archived</span>
          <button type="button" onClick={onUndo}>
            Undo
          </button>
        </div>
      ) : (
        open && (
          <div className="wb-body">
            <p className="wb-next">
              {matter.nextAction || "Review the latest conversation."}
            </p>
            <p className="wb-meta tabular">
              {yours ? "yours" : `with ${owner}`}
              {" · "}
              {stale ? (
                <span className="wb-stale">{age}d since it moved</span>
              ) : (
                `${age}d since it moved`
              )}
              {matter.conversations.length > 1
                ? ` · ${matter.conversations.length} threads`
                : ""}
            </p>
            {matter.summary ? <p className="wb-meta tabular">{matter.summary}</p> : null}
            <div className="wb-acts">
              {onReply && (
                <button type="button" className="wb-btn wb-btn-primary" onClick={onReply}>
                  {yours ? "Reply" : `Nudge ${owner}`}
                </button>
              )}
              {onForward && (
                <button type="button" className="wb-btn" onClick={onForward}>
                  Forward
                </button>
              )}
              <button type="button" className="wb-btn" onClick={onArchive}>
                Archive
              </button>
              <button type="button" className="wb-btn" onClick={onOpenMatter}>
                Open
              </button>
            </div>
          </div>
        )
      )}
    </div>
  );
}

function MatterDetail({
  matter,
  onClose,
  onOpenConversation,
}: {
  matter: MatterCard;
  onClose: () => void;
  onOpenConversation?: (conversation: ConversationRow) => void;
}) {
  const closeRef = useRef<HTMLButtonElement>(null);
  const previousFocus = useRef<HTMLElement | null>(null);

  useEffect(() => {
    previousFocus.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    closeRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      previousFocus.current?.focus();
    };
  }, [onClose]);

  return (
    <div className="atlas-detail-backdrop" role="presentation">
      <aside
        className="atlas-detail"
        role="dialog"
        aria-modal="true"
        aria-labelledby="atlas-detail-title"
        tabIndex={-1}
      >
        <header className="atlas-detail-header">
          <div>
            <p className="atlas-detail-kicker atlas-heading">{matter.section}</p>
            <h2 id="atlas-detail-title" className="seer-display">
              {matter.shortTitle}
            </h2>
          </div>
          <button
            ref={closeRef}
            type="button"
            className="mail-close mail-focus-ring"
            onClick={onClose}
            aria-label="Close matter detail"
          >
            <X aria-hidden />
          </button>
        </header>

        <p className="atlas-detail-summary">{matter.summary || "Current matter activity."}</p>
        <dl className="atlas-detail-action">
          <div>
            <dt>Next action</dt>
            <dd>{matter.nextAction || "Review the latest conversation."}</dd>
          </div>
          <div>
            <dt>Owner</dt>
            <dd>{matter.owner}</dd>
          </div>
          {matter.dueDate ? (
            <div>
              <dt>Due</dt>
              <dd>{matter.dueDate}</dd>
            </div>
          ) : null}
        </dl>

        <section aria-labelledby="atlas-conversations-title">
          <h3 id="atlas-conversations-title">Conversations</h3>
          <ul className="atlas-detail-conversations">
            {matter.conversations.map((conversation) => (
              <li key={conversation.conversationId}>
                <button
                  type="button"
                  onClick={() => onOpenConversation?.(conversation)}
                  className="atlas-detail-conversation mail-focus-ring"
                >
                  <span className="atlas-detail-conversation-topline">
                    <strong>{conversation.subject || "(no subject)"}</strong>
                    <time dateTime={conversation.at}>
                      {conversation.at
                        ? new Date(conversation.at).toLocaleDateString()
                        : ""}
                    </time>
                  </span>
                  <span className="atlas-detail-conversation-sender">
                    {conversation.from}
                  </span>
                  <span className="atlas-detail-conversation-summary">
                    {conversation.summary || "No summary available."}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      </aside>
    </div>
  );
}

function Chevron({ open }: { open: boolean }) {
  const Icon = open ? ChevronDown : ChevronRight;
  return <Icon className="h-4 w-4 shrink-0 text-[var(--fg)]" aria-hidden />;
}
