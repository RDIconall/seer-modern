"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
  closestCorners,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  arrayMove,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { BarChart3, Download, GripVertical, Sunrise, X } from "lucide-react";
import type { Brief, FiledEmail, Matter } from "@/lib/inbox/matters";
import { formatAmount } from "@/lib/crm/registry";

/**
 * Inbox / board / triage counts, in BOTH conversations and messages (#17).
 * Conversations are threads; messages are the raw provider count. Computed
 * from the stored brief so it always agrees with what is on the board.
 */
function boardCounts(brief: Brief) {
  const matters = [...(brief.pinned ?? []), ...brief.matters];
  const boardThreads = new Set(matters.flatMap((m) => m.threadIds));
  const boardMessages = new Set(matters.flatMap((m) => m.emailIds)).size;

  const triageThreads = new Set<string>();
  let triageMessages = 0;
  for (const f of brief.filed ?? []) {
    triageThreads.add(f.threadId);
    triageMessages += f.count ?? 1;
  }
  for (const theme of brief.digest?.themes ?? []) {
    for (const item of theme.items ?? []) {
      if (item.threadId) triageThreads.add(item.threadId);
      triageMessages += 1;
    }
  }

  return {
    inbox: {
      conversations: brief.providerTotal?.threads ?? brief.totalThreads ?? 0,
      messages:
        brief.providerTotal?.messages ?? brief.totalInbox ?? 0,
    },
    board: { conversations: boardThreads.size, messages: boardMessages },
    triage: { conversations: triageThreads.size, messages: triageMessages },
  };
}

/**
 * ATLAS — the CEO whiteboard. Every matter is one bare name under its
 * function heading; everything about it lives in the panel that opens on
 * click. One system column, Triage, holds inbox mail not yet a matter.
 * Drag a matter between columns to re-file it, drag within a column to set
 * your own order, and drag a Triage row into a function column to make it a
 * matter. Settling a matter archives it — there is no separate parking lot.
 */

const TRIAGE = "__triage__";

export type CatchupData = {
  since: string;
  newCount: number;
  needsYou: number;
  fyi: number;
  cleared: number;
  headlines: { id: string; who: string; line: string }[];
};

type BoardRow =
  | { kind: "matter"; id: string; matter: Matter }
  | { kind: "filed"; id: string; filed: FiledEmail };

type BoardSection = {
  key: string;
  label: string;
  kind: "function" | "triage";
  rows: BoardRow[];
};

/**
 * The Atlas top strip: what used to be a full stats tile is now a single
 * quiet line. The catch-up "while you were away" summary collapses to one
 * icon that opens on demand; the inbox export sits beside it. Neither steals
 * a quarter of the whiteboard.
 */
function AtlasTopBar({
  brief,
  catchup,
  onOpenEmail,
  onDismissCatchup,
}: {
  brief: Brief;
  catchup?: CatchupData | null;
  onOpenEmail: (id: string) => void;
  onDismissCatchup?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [countsOpen, setCountsOpen] = useState(false);
  const hasCatchup = Boolean(catchup && catchup.newCount > 0);
  const counts = useMemo(() => boardCounts(brief), [brief]);
  const sinceLabel = catchup
    ? new Date(catchup.since).toLocaleString([], {
        weekday: "short",
        hour: "numeric",
        minute: "2-digit",
      })
    : "";
  return (
    <div className="relative flex items-center justify-end gap-1 px-4 py-2">
      <button
        type="button"
        onClick={() => {
          setCountsOpen((v) => !v);
          setOpen(false);
        }}
        aria-label="Inbox counts"
        aria-expanded={countsOpen}
        className="flex items-center gap-1 rounded-full px-2 py-1 text-[12px] text-[var(--fg)] hover:bg-[var(--row-hover)] hover:text-[var(--fg-strong)]"
      >
        <BarChart3 className="h-4 w-4" />
        <span className="font-bold">{counts.board.conversations}</span>
        <span>/ {counts.inbox.conversations}</span>
      </button>
      {hasCatchup ? (
        <button
          type="button"
          onClick={() => {
            setOpen((v) => !v);
            setCountsOpen(false);
          }}
          aria-label="While you were away"
          aria-expanded={open}
          className="flex items-center gap-1 rounded-full px-2 py-1 text-[12px] text-[var(--brand)] hover:bg-[var(--row-hover)]"
        >
          <Sunrise className="h-4 w-4" />
          <span className="font-bold">{catchup!.needsYou}</span>
        </button>
      ) : null}
      <a
        href="/api/export/inbox"
        className="flex items-center gap-1 rounded-full px-2 py-1 text-[12px] text-[var(--fg)] hover:bg-[var(--row-hover)] hover:text-[var(--fg-strong)]"
        aria-label="Export inbox as CSV"
      >
        <Download className="h-4 w-4" />
        <span>Export</span>
      </a>

      {countsOpen ? (
        <div className="absolute right-4 top-full z-40 mt-1 w-72 max-w-[90vw] overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--bg)] p-3 text-[var(--fg-strong)] shadow-lg">
          <table className="w-full text-[13px]">
            <thead>
              <tr className="text-left text-[12px] font-bold">
                <th className="pb-1"> </th>
                <th className="pb-1 text-right">Conversations</th>
                <th className="pb-1 text-right">Messages</th>
              </tr>
            </thead>
            <tbody>
              {[
                { label: "Inbox", c: counts.inbox },
                { label: "On the board", c: counts.board },
                { label: "In Triage", c: counts.triage },
              ].map((r) => (
                <tr key={r.label}>
                  <td className="py-0.5 font-bold">{r.label}</td>
                  <td className="py-0.5 text-right">{r.c.conversations}</td>
                  <td className="py-0.5 text-right">{r.c.messages}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}

      {open && catchup ? (
        <div className="absolute right-4 top-full z-40 mt-1 w-80 max-w-[90vw] overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--bg)] p-3 shadow-lg">
          <div className="flex items-start justify-between gap-2">
            <p className="text-[14px] font-bold text-[var(--fg-strong)]">
              While you were away{" "}
              <span className="font-normal text-[var(--fg)]">
                (since {sinceLabel})
              </span>
            </p>
            <button
              type="button"
              onClick={() => {
                setOpen(false);
                onDismissCatchup?.();
              }}
              aria-label="Dismiss"
              className="shrink-0 text-[var(--fg)] hover:text-[var(--fg-strong)]"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
          <p className="mt-0.5 text-[14px] text-[var(--fg)]">
            {catchup.newCount} new · {catchup.needsYou} need you
            {catchup.fyi > 0 ? ` · ${catchup.fyi} FYI` : ""}
            {catchup.cleared > 0 ? ` · ${catchup.cleared} ready to clear` : ""}
          </p>
          {catchup.headlines.length > 0 ? (
            <ul className="mt-1.5 space-y-1">
              {catchup.headlines.map((h) => (
                <li key={h.id}>
                  <button
                    type="button"
                    onClick={() => {
                      setOpen(false);
                      onOpenEmail(h.id);
                    }}
                    className="w-full truncate text-left text-[14px]"
                  >
                    <span className="text-[var(--fg-strong)]">{h.who}</span>{" "}
                    <span className="text-[var(--fg)]">— {h.line}</span>
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/** Root function for an orgUnit like "operations — studies — RCD_2818" */
function orgRoot(orgUnit: string, functions: string[]): string {
  const lower = orgUnit.toLowerCase();
  let best = "";
  for (const f of functions) {
    const fl = f.toLowerCase();
    if ((lower === fl || lower.startsWith(fl)) && fl.length > best.length)
      best = f;
  }
  return best || orgUnit;
}

/** A filed row's line is "Who — summary"; the summary makes the best title. */
function titleFromLine(line: string): string {
  const parts = line.split(" — ");
  const t = parts.length > 1 ? parts.slice(1).join(" — ") : line;
  return t.trim().slice(0, 80);
}

/** Apply the user's saved order first, natural (urgency) order after. */
function applyOrder<T extends { id: string }>(
  items: T[],
  orderIds?: string[],
): T[] {
  if (!orderIds?.length) return items;
  const idx = new Map(orderIds.map((id, i) => [id, i]));
  return [...items].sort((a, b) => {
    const ia = idx.has(a.id) ? (idx.get(a.id) as number) : Infinity;
    const ib = idx.has(b.id) ? (idx.get(b.id) as number) : Infinity;
    return ia - ib;
  });
}

function ownerGlyph(owner: string): { glyph: string; cls: string } {
  if (owner === "you") return { glyph: "●", cls: "text-[var(--brand)]" };
  if (owner === "them") return { glyph: "◌", cls: "text-[var(--muted)]" };
  return { glyph: "–", cls: "text-[var(--nav-muted)]" };
}

function MatterRow({
  m,
  sectionKey,
  active,
  onOpen,
}: {
  m: Matter;
  sectionKey: string;
  active: boolean;
  onOpen: () => void;
}) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({
    id: `matter:${m.id}`,
    data: { type: "matter", sectionKey },
  });
  const g = ownerGlyph(m.owner);
  return (
    <li
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={`group flex items-baseline gap-1 rounded ${
        isDragging ? "opacity-40" : ""
      } ${active ? "bg-[var(--brand-soft)]" : ""}`}
    >
      <button
        type="button"
        {...attributes}
        {...listeners}
        aria-label="Drag matter"
        className="shrink-0 cursor-grab touch-none self-center text-[var(--nav-muted)] opacity-40 hover:opacity-100 active:cursor-grabbing"
      >
        <GripVertical className="h-3.5 w-3.5" />
      </button>
      <span className={`shrink-0 text-[12px] ${g.cls}`} title={m.owner}>
        {g.glyph}
      </span>
      <button
        type="button"
        onClick={onOpen}
        className="min-w-0 flex-1 py-1 text-left text-[14px] leading-5"
      >
        {/* A matter name is content, not a heading — Regular 400. */}
        <span className="line-clamp-2 text-[var(--fg-strong)]">{m.title}</span>
        {m.crm?.amount ? (
          <span className="text-[var(--brand)]">
            {" "}
            {formatAmount(m.crm.amount)}
          </span>
        ) : null}
      </button>
    </li>
  );
}

function FiledRow({
  f,
  onOpen,
}: {
  f: FiledEmail;
  onOpen: () => void;
}) {
  const { attributes, listeners, setNodeRef, transform, isDragging } =
    useSortable({
      id: `filed:${f.emailId}`,
      data: { type: "filed", filed: f, sectionKey: TRIAGE },
    });
  return (
    <li
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform) }}
      className={`group flex items-baseline gap-1 rounded ${
        isDragging ? "opacity-40" : ""
      }`}
    >
      <button
        type="button"
        {...attributes}
        {...listeners}
        aria-label="Drag into a column"
        className="shrink-0 cursor-grab touch-none self-center text-[var(--nav-muted)] opacity-40 hover:opacity-100 active:cursor-grabbing"
      >
        <GripVertical className="h-3.5 w-3.5" />
      </button>
      <button
        type="button"
        onClick={onOpen}
        className="min-w-0 flex-1 py-1 text-left text-[14px] leading-5 text-[var(--muted)] hover:text-[var(--fg)]"
      >
        <span className="line-clamp-2 block">
          {f.matterCandidate?.title ?? f.line}
          {f.count && f.count > 1 ? (
            <span className="text-[var(--nav-muted)]"> · {f.count}</span>
          ) : null}
        </span>
      </button>
    </li>
  );
}

function Column({
  section,
  activeMatterId,
  onOpenMatter,
  onOpenEmail,
}: {
  section: BoardSection;
  activeMatterId: string | null;
  onOpenMatter: (id: string) => void;
  onOpenEmail: (id: string) => void;
}) {
  const { setNodeRef, isOver } = useDroppable({
    id: `col:${section.key}`,
    data: { sectionKey: section.key, kind: section.kind },
  });
  const itemIds = section.rows.map((r) =>
    r.kind === "matter" ? `matter:${r.id}` : `filed:${r.id}`,
  );
  return (
    <section className="mb-4">
      <h2 className="text-[17px] font-bold text-[var(--fg-strong)]">
        {section.label}{" "}
        <span className="text-[var(--nav-muted)]">· {section.rows.length}</span>
      </h2>
      <SortableContext items={itemIds} strategy={verticalListSortingStrategy}>
        <ul
          ref={setNodeRef}
          className={`mt-0.5 min-h-[2rem] rounded ${
            isOver ? "bg-[var(--brand-soft)]/60 outline-1 outline-dashed outline-[var(--brand)]" : ""
          }`}
        >
          {section.rows.length === 0 ? (
            <li className="px-1 py-1 text-[12px] italic text-[var(--nav-muted)]">
              Drop a matter here
            </li>
          ) : null}
          {section.rows.map((r) =>
            r.kind === "matter" ? (
              <MatterRow
                key={r.id}
                m={r.matter}
                sectionKey={section.key}
                active={activeMatterId === r.id}
                onOpen={() => onOpenMatter(r.id)}
              />
            ) : (
              <FiledRow
                key={r.id}
                f={r.filed}
                onOpen={() => onOpenEmail(r.filed.emailId)}
              />
            ),
          )}
        </ul>
      </SortableContext>
    </section>
  );
}

export function AtlasBoard({
  brief,
  building,
  matterOrder,
  activeMatterId,
  catchup,
  onOpenMatter,
  onOpenEmail,
  onMoveMatter,
  onReorder,
  onCreateMatter,
  onDismissCatchup,
  mobile,
}: {
  brief: Brief | null;
  building: boolean;
  matterOrder: Record<string, string[]>;
  activeMatterId: string | null;
  catchup?: CatchupData | null;
  onOpenMatter: (id: string) => void;
  onOpenEmail: (id: string) => void;
  onMoveMatter: (matterId: string, orgUnit: string) => Promise<void>;
  onReorder: (orgUnit: string, matterIds: string[]) => void;
  onCreateMatter: (title: string, emailIds: string[], orgUnit?: string) => void;
  onDismissCatchup?: () => void;
  mobile?: boolean;
}) {
  const [activeId, setActiveId] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  // Mobile: long-press a matter to open a "move to" sheet (no dragging).
  const [moveFor, setMoveFor] = useState<string | null>(null);
  const pressTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const longPressFired = useRef(false);
  const startPress = (matterId: string) => {
    longPressFired.current = false;
    pressTimer.current = setTimeout(() => {
      longPressFired.current = true;
      setMoveFor(matterId);
    }, 450);
  };
  const cancelPress = () => {
    if (pressTimer.current) clearTimeout(pressTimer.current);
    pressTimer.current = null;
  };
  const openAfterPress = (matterId: string) => {
    if (longPressFired.current) {
      longPressFired.current = false;
      return;
    }
    onOpenMatter(matterId);
  };

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    }),
  );

  const functions = useMemo(() => brief?.functions ?? [], [brief]);

  // Build the ordered sections: function columns, then Triage.
  const sections = useMemo<BoardSection[]>(() => {
    if (!brief) return [];
    const allMatters = [...(brief.pinned ?? []), ...brief.matters];
    const byFn = new Map<string, Matter[]>();
    for (const m of allMatters) {
      const root = orgRoot(m.orgUnit, functions);
      const list = byFn.get(root) ?? [];
      list.push(m);
      byFn.set(root, list);
    }

    // Function columns in registry order first, then any extra roots.
    const order = [...functions, ...byFn.keys()].filter(
      (v, i, a) => a.indexOf(v) === i,
    );
    const fnSections: BoardSection[] = order
      .filter((fn) => byFn.has(fn))
      .map((fn) => ({
        key: fn,
        label: fn,
        kind: "function" as const,
        rows: applyOrder(byFn.get(fn) as Matter[], matterOrder[fn]).map(
          (m) => ({ kind: "matter" as const, id: m.id, matter: m }),
        ),
      }));

    const triageSection: BoardSection = {
      key: TRIAGE,
      label: "Triage",
      kind: "triage",
      rows: (brief.filed ?? [])
        .filter((f) => f.matterCandidate)
        .map((f) => ({
          kind: "filed" as const,
          id: f.emailId,
          filed: f,
        })),
    };

    const result = [...fnSections];
    if (triageSection.rows.length > 0) result.push(triageSection);
    return result;
  }, [brief, functions, matterOrder]);

  // Ordered matter ids per column — the basis for reorder/move math.
  const orderedIdsByKey = useMemo(() => {
    const map: Record<string, string[]> = {};
    for (const s of sections) {
      map[s.key] = s.rows
        .filter((r) => r.kind === "matter")
        .map((r) => r.id);
    }
    return map;
  }, [sections]);

  // Number of vertical tracks, from viewport width (one on a phone).
  const [tracks, setTracks] = useState(mobile ? 1 : 2);
  useEffect(() => {
    if (mobile) {
      setTracks(1);
      return;
    }
    const compute = () =>
      setTracks(
        window.innerWidth >= 1280 ? 3 : window.innerWidth >= 768 ? 2 : 1,
      );
    compute();
    window.addEventListener("resize", compute);
    return () => window.removeEventListener("resize", compute);
  }, [mobile]);

  // Greedy balance: each section joins the shortest track so columns stay
  // even. A heading counts as a row so an empty section isn't free.
  const trackBuckets = useMemo(() => {
    const buckets: BoardSection[][] = Array.from({ length: tracks }, () => []);
    const totals = new Array(tracks).fill(0);
    for (const s of sections) {
      let t = 0;
      for (let i = 1; i < tracks; i++) if (totals[i] < totals[t]) t = i;
      buckets[t].push(s);
      totals[t] += s.rows.length + 1;
    }
    return buckets;
  }, [sections, tracks]);

  function resolveSectionKey(overId: string, data: unknown): string | null {
    const d = data as { sectionKey?: string } | undefined;
    if (d?.sectionKey) return d.sectionKey;
    if (overId.startsWith("col:")) return overId.slice(4);
    return null;
  }

  function handleDragStart(e: DragStartEvent) {
    setActiveId(String(e.active.id));
  }

  async function handleDragEnd(e: DragEndEvent) {
    setActiveId(null);
    const { active, over } = e;
    if (!over) return;
    const a = active.data.current as
      | { type?: string; sectionKey?: string; filed?: FiledEmail }
      | undefined;
    const target = resolveSectionKey(String(over.id), over.data.current);
    if (!target) return;

    // A Triage row dragged into a function column becomes a matter.
    if (a?.type === "filed" && a.filed) {
      if (target === TRIAGE) return;
      const candidate = a.filed.matterCandidate;
      onCreateMatter(
        candidate?.title ?? titleFromLine(a.filed.line),
        candidate?.emailIds ?? [a.filed.emailId],
        target,
      );
      return;
    }

    if (a?.type !== "matter") return;
    const matterId = String(active.id).slice("matter:".length);
    const from = a.sectionKey as string;

    if (target === TRIAGE) return; // a matter is not inbox noise

    const overIsMatter =
      (over.data.current as { type?: string } | undefined)?.type === "matter";
    const overMatterId = overIsMatter
      ? String(over.id).slice("matter:".length)
      : null;

    if (from === target) {
      // Reorder within the same column.
      const ids = orderedIdsByKey[from] ?? [];
      const oldIndex = ids.indexOf(matterId);
      const newIndex = overMatterId ? ids.indexOf(overMatterId) : ids.length - 1;
      if (oldIndex !== -1 && newIndex !== -1 && oldIndex !== newIndex) {
        onReorder(from, arrayMove(ids, oldIndex, newIndex));
      }
      return;
    }

    // Move to a different function column, dropped where the cursor is.
    onMoveMatter(matterId, target);
    const targetIds = (orderedIdsByKey[target] ?? []).filter(
      (id) => id !== matterId,
    );
    let insertAt = targetIds.length;
    if (overMatterId) {
      const idx = targetIds.indexOf(overMatterId);
      if (idx !== -1) insertAt = idx;
    }
    targetIds.splice(insertAt, 0, matterId);
    onReorder(target, targetIds);
  }

  if (!brief) {
    return (
      <p className="px-4 py-4 text-[14px] text-[var(--muted)]">
        {building ? "Reading the inbox…" : "Nothing yet."}
      </p>
    );
  }

  const activeMatter =
    activeId?.startsWith("matter:")
      ? [...(brief.pinned ?? []), ...brief.matters].find(
          (m) => m.id === activeId.slice("matter:".length),
        )
      : null;
  const activeFiled =
    activeId?.startsWith("filed:")
      ? brief.filed?.find((f) => f.emailId === activeId.slice("filed:".length))
      : null;

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <AtlasTopBar
        brief={brief}
        catchup={catchup}
        onOpenEmail={onOpenEmail}
        onDismissCatchup={onDismissCatchup}
      />
      {building ? (
        <p className="px-4 pt-2 text-[12px] text-[var(--nav-muted)]">
          Reading…
        </p>
      ) : null}

      <DndContext
        sensors={sensors}
        collisionDetection={closestCorners}
        onDragStart={handleDragStart}
        onDragEnd={handleDragEnd}
        onDragCancel={() => setActiveId(null)}
      >
        <div className="flex gap-6 px-4 py-3">
          {trackBuckets.map((bucket, i) => (
            <div key={i} className="min-w-0 flex-1">
              {bucket.map((section) =>
                mobile ? (
                  <section key={section.key} className="mb-3">
                    <button
                      type="button"
                      onClick={() =>
                        setCollapsed((prev) => {
                          const next = new Set(prev);
                          if (next.has(section.key)) next.delete(section.key);
                          else next.add(section.key);
                          return next;
                        })
                      }
                      className="flex w-full items-baseline gap-2 text-left text-[17px] font-bold text-[var(--fg-strong)]"
                    >
                      {section.label}
                      <span className="text-[var(--nav-muted)]">
                        · {section.rows.length}
                      </span>
                      <span className="ml-auto text-[var(--nav-muted)]">
                        {collapsed.has(section.key) ? "+" : "–"}
                      </span>
                    </button>
                    {!collapsed.has(section.key) ? (
                      <ul className="mt-0.5">
                        {section.rows.map((r) =>
                          r.kind === "matter" ? (
                            <li
                              key={r.id}
                              className="flex items-baseline gap-1.5"
                            >
                              <span
                                className={`shrink-0 text-[12px] ${ownerGlyph(r.matter.owner).cls}`}
                              >
                                {ownerGlyph(r.matter.owner).glyph}
                              </span>
                              <button
                                type="button"
                                onClick={() => openAfterPress(r.id)}
                                onTouchStart={() => startPress(r.id)}
                                onTouchEnd={cancelPress}
                                onTouchMove={cancelPress}
                                onContextMenu={(e) => {
                                  e.preventDefault();
                                  setMoveFor(r.id);
                                }}
                                className="min-w-0 flex-1 py-2 text-left text-[17px] leading-6"
                              >
                                {/* Content weight, not heading weight. */}
                                <span className="line-clamp-2 text-[var(--fg-strong)]">
                                  {r.matter.title}
                                </span>
                              </button>
                            </li>
                          ) : (
                            <li key={r.id} className="flex">
                              <button
                                type="button"
                                onClick={() => onOpenEmail(r.filed.emailId)}
                                className="min-w-0 flex-1 py-2 text-left text-[14px] leading-5 text-[var(--muted)]"
                              >
                                <span className="line-clamp-2 block">
                                  {r.filed.matterCandidate?.title ??
                                    r.filed.line}
                                </span>
                              </button>
                            </li>
                          ),
                        )}
                      </ul>
                    ) : null}
                  </section>
                ) : (
                  <Column
                    key={section.key}
                    section={section}
                    activeMatterId={activeMatterId}
                    onOpenMatter={onOpenMatter}
                    onOpenEmail={onOpenEmail}
                  />
                ),
              )}
            </div>
          ))}
        </div>

        <DragOverlay>
          {activeMatter ? (
            <span className="rounded bg-[var(--card)] px-2 py-1 text-[14px] text-[var(--fg-strong)] shadow-lg ring-1 ring-[var(--border)]">
              {activeMatter.title}
            </span>
          ) : activeFiled ? (
            <span className="rounded bg-[var(--card)] px-2 py-1 text-[14px] text-[var(--muted)] shadow-lg ring-1 ring-[var(--border)]">
              {activeFiled.line}
            </span>
          ) : null}
        </DragOverlay>
      </DndContext>

      {/* Mobile move-to sheet: long-press a matter, pick a new home */}
      {moveFor ? (
        <div className="fixed inset-0 z-50 flex items-end">
          <button
            type="button"
            aria-label="Close"
            onClick={() => setMoveFor(null)}
            className="absolute inset-0 bg-black/40"
          />
          <div className="relative z-10 max-h-[70vh] w-full overflow-y-auto rounded-t-2xl bg-[var(--bg)] pb-[var(--safe-bottom)] pt-2 shadow-xl">
            <p className="px-4 py-2 text-[12px] font-bold text-[var(--nav-muted)]">
              Move to
            </p>
            {functions.map((f) => (
              <button
                key={f}
                type="button"
                onClick={async () => {
                  await onMoveMatter(moveFor, f);
                  setMoveFor(null);
                }}
                className="block w-full px-4 py-3 text-left text-[17px] text-[var(--fg)]"
              >
                {f}
              </button>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}
