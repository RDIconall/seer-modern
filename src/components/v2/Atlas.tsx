"use client";

import * as React from "react";
import { useEffect, useMemo, useRef, useState } from "react";
import { GripVertical } from "lucide-react";
import type {
  ConversationRow,
  InboxView,
  MatterCard,
} from "@/lib/v2/view/types";
import { reorderMatterSections } from "@/lib/v2/view/matter-order";
import { MobileMailRow } from "@/components/v3/MobileMailRow";

export type MatterMove = {
  matterId: string;
  fromSection: string;
  toSection: string;
  sourceMatterIds: string[];
  targetMatterIds: string[];
};

export type AtlasDropTarget = {
  section: string;
  beforeMatterId: string | null;
};

/**
 * Pointer travel before a press on the grip counts as a drag. Without it every
 * brush of the handle opened a drag and committed a drop wherever the finger
 * happened to lift, which is most of what made the board feel arbitrary.
 */
const DRAG_SLOP_PX = 4;

/** How near the edge of the scrollport a drag must come before the board
 *  follows it, and how far it then travels each frame. A matter could not be
 *  moved to a section that was off-screen until the board scrolled itself. */
const AUTOSCROLL_EDGE_PX = 72;
const AUTOSCROLL_STEP_PX = 14;

/** Whether a press has travelled far enough to be meant as a drag. */
export function atlasDragTravelled(
  start: { x: number; y: number },
  point: { x: number; y: number },
): boolean {
  return (
    Math.abs(point.x - start.x) >= DRAG_SLOP_PX ||
    Math.abs(point.y - start.y) >= DRAG_SLOP_PX
  );
}

/**
 * Where a matter lands when the arrow keys move it one place. Moving up means
 * "in front of the row above"; moving down means "behind the row below", which
 * is the row after that one — or the end of the section when there is none.
 */
export function atlasNudgeTarget(
  matterIds: readonly string[],
  matterId: string,
  delta: -1 | 1,
): { beforeMatterId: string | null } | null {
  const from = matterIds.indexOf(matterId);
  if (from < 0) return null;
  const to = from + delta;
  if (to < 0 || to >= matterIds.length) return null;
  return {
    beforeMatterId: delta < 0 ? matterIds[to] : (matterIds[to + 1] ?? null),
  };
}

/** The next matter row after this one, which is what "drop below it" means. */
function matterAfter(row: HTMLElement): string | null {
  for (let node = row.nextElementSibling; node; node = node.nextElementSibling) {
    const id = (node as HTMLElement).dataset?.atlasMatter;
    if (id) return id;
  }
  return null;
}

/**
 * Resolve the row/section under a pointer. Native HTML drag events work with a
 * mouse but not reliably on iOS, so one pointer path hit-tests the board and
 * hands the result to the exact same persisted reorder command.
 *
 * `clientY` splits the row it lands on: above the midpoint the matter goes in
 * ahead of that row, below it goes after. Treating any touch of a row as
 * "insert before" put every drop one place higher than the gap being pointed
 * at, and made dropping at the foot of a section impossible.
 */
export function atlasDropTarget(
  element: Element | null,
  clientY?: number,
): AtlasDropTarget | null {
  const matter = element?.closest<HTMLElement>("[data-atlas-matter]");
  const column = element?.closest<HTMLElement>("[data-atlas-section]");
  const section = matter?.dataset.atlasSection ?? column?.dataset.atlasSection;
  if (!section) return null;
  if (!matter) return { section, beforeMatterId: null };
  const box = matter.getBoundingClientRect?.();
  if (clientY !== undefined && box && box.height > 0) {
    if (clientY > box.top + box.height / 2) {
      return { section, beforeMatterId: matterAfter(matter) };
    }
  }
  return {
    section,
    beforeMatterId: matter.dataset.atlasMatter ?? null,
  };
}

/** The element that actually scrolls the board, so a drag can drive it. */
function scrollportFor(element: Element | null): HTMLElement | null {
  for (let node = element?.parentElement ?? null; node; node = node.parentElement) {
    const overflow = window.getComputedStyle(node).overflowY;
    if (
      /(auto|scroll|overlay)/.test(overflow) &&
      node.scrollHeight > node.clientHeight + 1
    ) {
      return node;
    }
  }
  return null;
}

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

/** The thread a matter is currently living on: its most recent conversation. */
function latestConversation(matter: MatterCard): ConversationRow | null {
  let latest: ConversationRow | null = null;
  let latestAt = -1;
  for (const conversation of matter.conversations) {
    const at = conversation.at ? Date.parse(conversation.at) : NaN;
    const rank = Number.isNaN(at) ? 0 : at;
    if (rank >= latestAt) {
      latestAt = rank;
      latest = conversation;
    }
  }
  return latest;
}

const mailDate = (iso: string) => {
  const at = Date.parse(iso);
  if (Number.isNaN(at)) return "";
  return new Date(at).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
};

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
 * Stalled means someone is actually blocked and it has been a fortnight. A week
 * is the normal gap between replies, and calling that stalled made the word
 * describe most of the board, which is the same as describing none of it.
 */
const STALE_DAYS = 14;

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
 * Outreach nobody has answered. We wrote last on every thread of it, so the ball
 * is not on this side: it is a pipeline row, not a matter and not stalled.
 *
 * Rolling these up is what takes a section from screens-worth to a few lines,
 * and it is also what makes "stalled" mean something again — counting mail
 * nobody owes us a reply on as stalled work described most of the board.
 */
const isAwaitingReply = (matter: MatterCard) =>
  matter.conversations.length > 0 &&
  matter.conversations.every((conversation) => conversation.weSpokeLast);

/** Blocked work: someone owes a move and a fortnight has passed. */
const isStalled = (matter: MatterCard, now: number) =>
  !isAwaitingReply(matter) && daysSinceMoved(matter, now) >= STALE_DAYS;

export function Atlas({
  view,
  onArchiveMatter,
  onReplyMatter,
  onForwardMatter,
  onOpenConversation,
  onReorderMatters,
  onMoveMatter,
  currentConversationId,
  onArchiveConversation,
  onDeleteConversation,
}: {
  view: InboxView;
  onArchiveMatter?: (matter: MatterCard) => void | Promise<unknown>;
  onReplyMatter?: (matter: MatterCard) => void;
  onForwardMatter?: (matter: MatterCard) => void;
  onOpenConversation?: (conversation: ConversationRow) => void;
  onReorderMatters?: (
    section: string,
    matterIds: string[],
  ) => void | Promise<unknown>;
  onMoveMatter?: (move: MatterMove) => void | Promise<unknown>;
  currentConversationId?: string | null;
  onArchiveConversation?: (conversation: ConversationRow) => void;
  onDeleteConversation?: (conversation: ConversationRow) => void;
}) {
  // Only "mine" narrows the board. A matter row opens its latest real email in
  // the shared reader; Atlas is an index of work, not a second detail view.
  const [mineOnly, setMineOnly] = useState(false);
  const [openRolls, setOpenRolls] = useState<ReadonlySet<string>>(new Set());
  const [archived, setArchived] = useState<ReadonlySet<string>>(new Set());
  const [undoable, setUndoable] = useState<ReadonlySet<string>>(new Set());
  const undoTimers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const [boardSections, setBoardSections] = useState(view.sections);
  type DraggedMatter = {
    matterId: string;
    fromSection: string;
    startX: number;
    startY: number;
    /** False until the pointer has travelled far enough to mean it. */
    active: boolean;
  };
  const [dragged, setDragged] = useState<{ matterId: string } | null>(null);
  // Pointer-up can arrive before React has committed the render caused by
  // pointer-down. The ref is the drag transaction; state is only its paint.
  const draggedRef = useRef<DraggedMatter | null>(null);
  const [hover, setHover] = useState<AtlasDropTarget | null>(null);
  const hoverRef = useRef<AtlasDropTarget | null>(null);
  const boardRef = useRef<HTMLElement | null>(null);
  const scrollportRef = useRef<HTMLElement | null>(null);
  const pointerRef = useRef({ x: 0, y: 0 });
  const frameRef = useRef<number | null>(null);
  // A drop is applied locally and then confirmed by the server. Until it comes
  // back the incoming view still describes the old order, and letting it repaint
  // the board is what snapped a dragged matter back to where it started.
  const [pendingMoves, setPendingMoves] = useState(0);

  useEffect(() => {
    if (pendingMoves > 0) return;
    setBoardSections(view.sections);
  }, [view.sections, pendingMoves]);

  useEffect(
    () => () => {
      if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
    },
    [],
  );

  const sections = boardSections;

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
          matters: kept.filter((matter) => !isAwaitingReply(matter)),
          parked: mineOnly ? [] : kept.filter(isAwaitingReply),
        };
      }),
    // `now` is deliberately excluded: it changes every render and ages move by
    // the day, not the frame.
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
  // Outreach nobody has answered is excluded here on purpose: it is the whole
  // reason the number is worth reading.
  const stalled = live.filter((matter) => isStalled(matter, now)).length;
  const rowCount = shaped.reduce(
    (n, section) => n + section.matters.length + (section.parked.length > 0 ? 1 : 0),
    0,
  );

  const archive = (matter: MatterCard) => {
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

  const applyHover = (next: AtlasDropTarget | null) => {
    const prev = hoverRef.current;
    if (
      prev?.section === next?.section &&
      prev?.beforeMatterId === next?.beforeMatterId
    ) {
      return;
    }
    hoverRef.current = next;
    setHover(next);
  };

  const endDrag = () => {
    draggedRef.current = null;
    if (frameRef.current !== null) {
      cancelAnimationFrame(frameRef.current);
      frameRef.current = null;
    }
    applyHover(null);
    setDragged(null);
  };

  const commit = async (run: () => void | Promise<unknown>) => {
    setPendingMoves((n) => n + 1);
    try {
      await run();
    } finally {
      setPendingMoves((n) => Math.max(0, n - 1));
    }
  };

  const dropMatter = (
    targetSection: string,
    beforeMatterId?: string | null,
  ) => {
    const active = draggedRef.current;
    if (!active) return;
    if (beforeMatterId === active.matterId) {
      endDrag();
      return;
    }
    const result = reorderMatterSections(boardSections, {
      matterId: active.matterId,
      targetSection,
      beforeMatterId,
    });
    endDrag();
    if (result.sections === boardSections) return;
    setBoardSections(result.sections);
    void commit(() =>
      result.sourceSection === result.targetSection
        ? onReorderMatters?.(result.targetSection, result.targetMatterIds)
        : onMoveMatter?.({
            matterId: active.matterId,
            fromSection: result.sourceSection,
            toSection: result.targetSection,
            sourceMatterIds: result.sourceMatterIds,
            targetMatterIds: result.targetMatterIds,
          }),
    );
  };

  const hoverAt = (x: number, y: number) => {
    applyHover(atlasDropTarget(document.elementFromPoint(x, y), y));
  };

  /** Drive the board's own scrollport while a drag sits against its edge. */
  const followEdge = () => {
    const { y } = pointerRef.current;
    const port = scrollportRef.current;
    const box = port?.getBoundingClientRect();
    const top = box ? box.top : 0;
    const bottom = box ? box.bottom : window.innerHeight;
    let delta = 0;
    if (y < top + AUTOSCROLL_EDGE_PX) delta = -AUTOSCROLL_STEP_PX;
    else if (y > bottom - AUTOSCROLL_EDGE_PX) delta = AUTOSCROLL_STEP_PX;
    if (delta === 0) return;
    if (port) port.scrollTop += delta;
    else window.scrollBy(0, delta);
  };

  const runFrame = () => {
    if (!draggedRef.current?.active) {
      frameRef.current = null;
      return;
    }
    followEdge();
    // The board moves under a finger that is holding still, so the target is
    // recomputed every frame rather than only when the pointer reports one.
    hoverAt(pointerRef.current.x, pointerRef.current.y);
    frameRef.current = requestAnimationFrame(runFrame);
  };

  const beginDrag = (
    matterId: string,
    fromSection: string,
    x: number,
    y: number,
  ) => {
    draggedRef.current = {
      matterId,
      fromSection,
      startX: x,
      startY: y,
      active: false,
    };
    pointerRef.current = { x, y };
    scrollportRef.current = scrollportFor(boardRef.current);
  };

  const moveDrag = (x: number, y: number) => {
    const drag = draggedRef.current;
    if (!drag) return;
    pointerRef.current = { x, y };
    if (!drag.active) {
      if (!atlasDragTravelled({ x: drag.startX, y: drag.startY }, { x, y })) {
        return;
      }
      drag.active = true;
      setDragged({ matterId: drag.matterId });
      if (frameRef.current === null) {
        frameRef.current = requestAnimationFrame(runFrame);
      }
    }
    hoverAt(x, y);
  };

  const commitDrag = (x: number, y: number) => {
    const drag = draggedRef.current;
    if (!drag) return;
    // A press that never travelled is a press, not a move.
    if (!drag.active) {
      endDrag();
      return;
    }
    const target =
      atlasDropTarget(document.elementFromPoint(x, y), y) ?? hoverRef.current;
    if (target) dropMatter(target.section, target.beforeMatterId);
    else endDrag();
  };

  /**
   * The grip is a control, so it has to move a matter without a pointer too.
   *
   * `visibleIds` is the section as the user sees it, not as the board holds it:
   * a section also carries the outreach rolled up out of sight, and stepping
   * over one of those moved the matter past a row that was not on screen, which
   * reads as the key having done nothing at all.
   */
  const nudgeMatter = (
    matterId: string,
    section: string,
    visibleIds: string[],
    delta: -1 | 1,
  ) => {
    const target = atlasNudgeTarget(visibleIds, matterId, delta);
    if (!target) return;
    draggedRef.current = {
      matterId,
      fromSection: section,
      startX: 0,
      startY: 0,
      active: true,
    };
    dropMatter(section, target.beforeMatterId);
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
    <section aria-label="Atlas — the whiteboard" className="wb" ref={boardRef}>
      {/* Two rows of chrome, not three: the title and the account of the board
          share a line, and the filter carries the row count on its right.
          The mark and the search field live in the app toolbar directly above,
          so the board does not repeat either — the mockup draws them here only
          because it has no toolbar of its own. */}
      <header className="wb-top">
        {/* One display headline per screen, and on the board this is it. */}
        <span className="wb-title seer-display">Whiteboard</span>
        <span className="wb-ledger tabular">
          {yours} yours · {live.length - yours} out
          {stalled > 0 ? (
            <>
              {" · "}
              <span className="wb-stale">{stalled} stalled</span>
            </>
          ) : null}
        </span>
      </header>
      <div className="wb-seg" role="group" aria-label="Filter the board">
        <button type="button" aria-pressed={!mineOnly} onClick={() => setMineOnly(false)}>
          All
        </button>
        <button type="button" aria-pressed={mineOnly} onClick={() => setMineOnly(true)}>
          Mine
        </button>
        <span className="wb-dense tabular">{rowCount} rows</span>
      </div>

      {shown === 0 ? (
        <p className="wb-empty">Nothing is yours right now.</p>
      ) : (
        <div className="wb-columns">
          {shaped.map((section) => {
            if (section.matters.length === 0 && section.parked.length === 0) return null;
            const sectionStale = section.matters.filter((matter) =>
              isStalled(matter, now),
            ).length;
            const rollOpen = openRolls.has(section.name);
            return (
              <div
                key={section.name}
                className="wb-column"
                data-atlas-section={section.name}
              >
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
              <div
                className="wb-sec"
                data-drop-end={
                  hover?.section === section.name && hover.beforeMatterId === null
                    ? "true"
                    : undefined
                }
              >
                {section.matters.map((matter) => (
                  <BoardMatter
                    key={matter.matterId}
                    matter={matter}
                    now={now}
                    open={false}
                    archived={archived.has(matter.matterId)}
                    current={matter.conversations.some(
                      (conversation) =>
                        conversation.conversationId === currentConversationId,
                    )}
                    dragging={dragged?.matterId === matter.matterId}
                    dropBefore={
                      hover?.section === section.name &&
                      hover.beforeMatterId === matter.matterId &&
                      dragged?.matterId !== matter.matterId
                    }
                    onToggle={() => {
                      const conversation = latestConversation(matter);
                      if (conversation) onOpenConversation?.(conversation);
                    }}
                    onArchive={() => archive(matter)}
                    onUndo={() => undo(matter)}
                    onReply={onReplyMatter ? () => onReplyMatter(matter) : undefined}
                    onForward={onForwardMatter ? () => onForwardMatter(matter) : undefined}
                    currentConversationId={currentConversationId}
                    onOpenConversation={onOpenConversation}
                    onArchiveConversation={onArchiveConversation}
                    onDeleteConversation={onDeleteConversation}
                    onDragStart={(x, y) =>
                      beginDrag(matter.matterId, section.name, x, y)
                    }
                    onDragMove={moveDrag}
                    onDragDrop={commitDrag}
                    onDragEnd={endDrag}
                    onNudge={(delta) =>
                      nudgeMatter(
                        matter.matterId,
                        section.name,
                        section.matters.map((row) => row.matterId),
                        delta,
                      )
                    }
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
                      <span className="wb-mt">Outreach, no reply</span>
                      <span className="wb-own tabular">—</span>
                      <span className="wb-age tabular">{section.parked.length}</span>
                    </button>
                    {rollOpen && (
                      <div className="wb-rlist">
                        {section.parked.map((matter) => {
                          const latest = latestConversation(matter);
                          return (
                            <button
                              key={matter.matterId}
                              type="button"
                              className="wb-rrow"
                              disabled={!latest}
                              onClick={() =>
                                latest && onOpenConversation?.(latest)
                              }
                            >
                              <span>{matter.shortTitle}</span>
                              <span className="tabular">{daysSinceMoved(matter, now)}d</span>
                            </button>
                          );
                        })}
                      </div>
                    )}
                  </div>
                )}
              </div>
              </div>
            );
          })}
        </div>
      )}

      <p className="wb-foot tabular">
        {`${rowCount} rows · ${view.coverage.stored - view.coverage.read} unread by Seer`}
        {`\nAccounted ${view.coverage.read} of ${view.coverage.providerTotal}`}
      </p>

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
  current,
  dragging,
  dropBefore,
  onToggle,
  onArchive,
  onUndo,
  onReply,
  onForward,
  currentConversationId,
  onOpenConversation,
  onArchiveConversation,
  onDeleteConversation,
  onDragStart,
  onDragMove,
  onDragDrop,
  onDragEnd,
  onNudge,
}: {
  matter: MatterCard;
  now: number;
  open: boolean;
  archived: boolean;
  current: boolean;
  dragging: boolean;
  dropBefore: boolean;
  onToggle: () => void;
  onArchive: () => void;
  onUndo: () => void;
  onReply?: () => void;
  onForward?: () => void;
  currentConversationId?: string | null;
  onOpenConversation?: (conversation: ConversationRow) => void;
  onArchiveConversation?: (conversation: ConversationRow) => void;
  onDeleteConversation?: (conversation: ConversationRow) => void;
  onDragStart: (clientX: number, clientY: number) => void;
  onDragMove: (clientX: number, clientY: number) => void;
  onDragDrop: (clientX: number, clientY: number) => void;
  onDragEnd: () => void;
  onNudge: (delta: -1 | 1) => void;
}) {
  const age = daysSinceMoved(matter, now);
  const stalled = isStalled(matter, now);
  const owner = ownerLabel(matter);
  const yours = isYours(matter);

  return (
    <div
      className={`wb-m${open ? " wb-m-open" : ""}${archived ? " wb-m-gone" : ""}${
        yours ? " wb-m-yours" : ""
      }${current ? " wb-m-current" : ""}`}
      data-atlas-matter={matter.matterId}
      data-atlas-section={matter.section}
      data-dragging={dragging ? "true" : undefined}
      data-drop-before={dropBefore ? "true" : undefined}
    >
      <button
        type="button"
        className="wb-drag"
        aria-label={`Drag ${matter.shortTitle}`}
        onPointerDown={(event) => {
          if (archived) return;
          event.preventDefault();
          event.stopPropagation();
          // Capture keeps the move and the release on this handle even when the
          // pointer leaves it, which is every drag that goes anywhere.
          try {
            event.currentTarget.setPointerCapture(event.pointerId);
          } catch {
            /* a pointer the browser has already released cannot be captured */
          }
          event.currentTarget.focus();
          onDragStart(event.clientX, event.clientY);
        }}
        onPointerMove={(event) => {
          if (archived) return;
          onDragMove(event.clientX, event.clientY);
        }}
        onPointerUp={(event) => {
          if (archived) return;
          onDragDrop(event.clientX, event.clientY);
        }}
        // A gesture the browser claims mid-drag, and the release of a capture
        // that ended some other way, both have to put the board back.
        onPointerCancel={onDragEnd}
        onLostPointerCapture={onDragEnd}
        onKeyDown={(event) => {
          if (archived) return;
          if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
          event.preventDefault();
          onNudge(event.key === "ArrowUp" ? -1 : 1);
        }}
      >
        <GripVertical aria-hidden />
      </button>
      {/* One line, three columns: what it is, who has it, how long it has sat.
          A chevron and a second line of prose per row is what turned a board of
          a hundred matters into eleven screens of scrolling. */}
      <button
        type="button"
        className="wb-mhead"
        aria-label={`Open latest email for ${matter.shortTitle}`}
        onClick={archived ? undefined : onToggle}
        disabled={archived}
      >
        <span className="wb-mt">{matter.shortTitle}</span>
        <span className={`wb-own tabular${yours ? " wb-own-you" : ""}`}>{owner}</span>
        <span className={`wb-age tabular${stalled ? " wb-stale" : ""}`}>{age}d</span>
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
              {stalled ? (
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
            </div>

            {/* The matter is its mail. One row per conversation, read the way
                every other message in Seer is read — in the reading pane. */}
            <div className="wb-mail" aria-label="Mail on this matter">
              {matter.conversations.map((conversation) => (
                <React.Fragment key={conversation.conversationId}>
                  <MobileMailRow
                    model={{
                      id: conversation.conversationId,
                      from: conversation.from,
                      subject: conversation.subject,
                      preview: conversation.summary,
                      when: mailDate(conversation.at),
                    }}
                    current={
                      conversation.conversationId === currentConversationId
                    }
                    onOpen={() => onOpenConversation?.(conversation)}
                    onArchive={() => onArchiveConversation?.(conversation)}
                    onDelete={() => onDeleteConversation?.(conversation)}
                  />
                  <button
                    type="button"
                    className="wb-mail-row"
                    data-current={
                      conversation.conversationId === currentConversationId
                        ? "true"
                        : "false"
                    }
                    onClick={() => onOpenConversation?.(conversation)}
                  >
                    <span className="wb-mail-top">
                      <strong>{conversation.from || "Unknown sender"}</strong>
                      <time className="tabular">{mailDate(conversation.at)}</time>
                    </span>
                    <span className="wb-mail-subject">
                      {conversation.subject || "(no subject)"}
                    </span>
                    {conversation.summary ? (
                      <span className="wb-mail-summary">{conversation.summary}</span>
                    ) : null}
                  </button>
                </React.Fragment>
              ))}
            </div>
          </div>
        )
      )}
    </div>
  );
}


