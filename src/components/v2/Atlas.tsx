"use client";

import * as React from "react";
import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, ChevronRight, X } from "lucide-react";
import type {
  AtlasSection,
  ConversationRow,
  InboxView,
  MatterCard,
} from "@/lib/v2/view/types";
import { useCollapsed } from "./useCollapsed";

/**
 * ATLAS — the whiteboard.
 *
 * The board is organised by SECTION: the part of the business, not the
 * counterparty. That is the axis the user's own whiteboard uses, and it is why
 * a matter carries a section as well as an org unit — "Roche stability fixes"
 * belongs beside the other engineering work, not beside the Roche invoice.
 *
 * Two ways to read it, both from the same server projection:
 *   List  — a collapsible outline, section → matter → conversations.
 *   Board — one column per section, matters as cards.
 *
 * Collapse state is remembered, so the shape you arrange is the shape you come
 * back to.
 */

type Mode = "list" | "board";

/**
 * Section names are shown exactly as the registry holds them. They are the
 * user's own headings — "sales — leads", "hr", "systems (it)" — and title-casing
 * turns "hr" into "Hr", which is not what anyone wrote on a whiteboard.
 */
function sectionLabel(name: string): string {
  return name === "unfiled" ? "unfiled" : name;
}

export function Atlas({
  view,
  onOpenConversation,
}: {
  view: InboxView;
  onOpenConversation?: (conversation: ConversationRow) => void;
}) {
  // The whiteboard is the default: it is the view that shows the whole business
  // at once. The outline is there for working down one section at a time.
  const [mode, setMode] = useState<Mode>("board");
  const [selectedMatterId, setSelectedMatterId] = useState<string | null>(null);
  const sections = view.sections;

  const allIds = useMemo(
    () => [
      ...sections.map((s) => `s:${s.name}`),
      ...sections.flatMap((s) => s.matters.map((m) => `m:${m.matterId}`)),
    ],
    [sections],
  );

  const { collapsed, loaded, hasStored, toggle, collapseAll, expandAll } =
    useCollapsed("seer.atlas.collapsed");

  // On a first visit, open the sections but fold the matters. A real board runs
  // to a hundred matters and several hundred conversations; opened flat that is
  // a wall of text with no shape. Folded, the outline of the business is
  // legible at a glance and you open only what you are working on. After that
  // the arrangement is the user's and is remembered.
  const seeded = useRef(false);
  useEffect(() => {
    if (!loaded || hasStored || seeded.current) return;
    seeded.current = true;
    const matterIds = sections.flatMap((s) =>
      s.matters.map((m) => `m:${m.matterId}`),
    );
    if (matterIds.length > 0) collapseAll(matterIds);
  }, [loaded, hasStored, sections, collapseAll]);

  const matterCount = sections.reduce((n, s) => n + s.matters.length, 0);

  if (sections.length === 0) {
    return (
      <section className="px-4 py-6 text-[14px] text-[var(--fg)]">
        No live matters yet.
      </section>
    );
  }

  return (
    <section aria-label="Atlas — the whiteboard" className="-mx-4">
      <header className="flex flex-wrap items-center justify-between gap-4 px-4 pb-5 pt-2">
        <div>
          <h1 className="seer-display text-[var(--fg-strong)]">Whiteboard</h1>
          <p className="mt-0.5 text-[length:var(--t-small)] text-[var(--muted)]">
            <span className="tabular">{matterCount}</span> matters ·{" "}
            <span className="tabular">{sections.length}</span> sections
          </p>
        </div>
        <div className="flex items-center gap-1.5 text-[13px]">
          <div className="inline-flex rounded-full bg-[var(--card)] p-[3px]">
            {(["board", "list"] as Mode[]).map((m) => (
              <button
                key={m}
                type="button"
                onClick={() => setMode(m)}
                aria-pressed={mode === m}
                className={`rounded-full px-3.5 py-1.5 capitalize transition-colors ${
                  mode === m
                    ? "bg-[var(--bg)] font-medium text-[var(--fg-strong)] shadow-[0_1px_3px_rgba(0,0,0,0.06)]"
                    : "text-[var(--muted)] hover:text-[var(--fg-strong)]"
                }`}
              >
                {m}
              </button>
            ))}
          </div>
          <button
            type="button"
            onClick={() => collapseAll(allIds)}
            className="rounded-full px-3 py-1.5 text-[var(--muted)] transition-colors hover:bg-[var(--row-hover)] hover:text-[var(--fg-strong)]"
          >
            Collapse all
          </button>
          <button
            type="button"
            onClick={expandAll}
            className="rounded-full px-3 py-1.5 text-[var(--muted)] transition-colors hover:bg-[var(--row-hover)] hover:text-[var(--fg-strong)]"
          >
            Expand all
          </button>
        </div>
      </header>

      {mode === "list" ? (
        <AtlasList
          sections={sections}
          collapsed={collapsed}
          toggle={toggle}
          onOpenMatter={(matter) => setSelectedMatterId(matter.matterId)}
          onOpenConversation={onOpenConversation}
        />
      ) : (
        <AtlasBoard
          sections={sections}
          collapsed={collapsed}
          toggle={toggle}
          onOpenMatter={(matter) => setSelectedMatterId(matter.matterId)}
          onOpenConversation={onOpenConversation}
        />
      )}
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

/* ---------------------------------------------------------------- List --- */

function AtlasList({
  sections,
  collapsed,
  toggle,
  onOpenMatter,
  onOpenConversation,
}: {
  sections: AtlasSection[];
  collapsed: Set<string>;
  toggle: (id: string) => void;
  onOpenMatter: (matter: MatterCard) => void;
  onOpenConversation?: (conversation: ConversationRow) => void;
}) {
  return (
    <div className="px-2 py-2">
      {sections.map((section) => {
        const sectionId = `s:${section.name}`;
        const open = !collapsed.has(sectionId);
        return (
          <div key={section.name} className="mb-1">
            <button
              type="button"
              onClick={() => toggle(sectionId)}
              aria-expanded={open}
              className="flex w-full items-center gap-2 rounded-lg px-2 py-2 text-left transition-colors hover:bg-[var(--row-hover)]"
            >
              <Chevron open={open} />
              <span className="text-[length:var(--t-body)] font-medium text-[var(--fg-strong)]">
                {sectionLabel(section.name)}
              </span>
              <span className="tabular text-[var(--muted)]">
                {section.matters.length}
              </span>
            </button>

            {open &&
              section.matters.map((matter) => (
                <MatterOutline
                  key={matter.matterId}
                  matter={matter}
                  collapsed={collapsed}
                  toggle={toggle}
                  onOpenMatter={onOpenMatter}
                  onOpenConversation={onOpenConversation}
                />
              ))}
          </div>
        );
      })}
    </div>
  );
}

function MatterOutline({
  matter,
  collapsed,
  toggle,
  onOpenMatter,
  onOpenConversation,
}: {
  matter: MatterCard;
  collapsed: Set<string>;
  toggle: (id: string) => void;
  onOpenMatter: (matter: MatterCard) => void;
  onOpenConversation?: (conversation: ConversationRow) => void;
}) {
  const matterId = `m:${matter.matterId}`;
  const open = !collapsed.has(matterId);
  const hasChildren = matter.conversations.length > 0 || matter.yields.length > 0;

  return (
    <div className="ml-4">
      <div className="flex items-center gap-2 rounded-lg px-2 py-1.5 transition-colors hover:bg-[var(--row-hover)]">
        {hasChildren ? (
          <button
            type="button"
            onClick={() => toggle(matterId)}
            aria-expanded={open}
            aria-label={open ? "Collapse matter" : "Expand matter"}
            className="shrink-0"
          >
            <Chevron open={open} />
          </button>
        ) : (
          <span className="inline-block h-4 w-4 shrink-0" />
        )}
        <button
          type="button"
          onClick={() => onOpenMatter(matter)}
          aria-label={`Open matter ${matter.shortTitle}`}
          className="min-w-0 flex-1 truncate text-left text-[14.5px] text-[var(--fg-strong)]"
        >
          {matter.shortTitle}
        </button>
        {matter.orgUnit && (
          <span className="shrink-0 rounded-full bg-[var(--card)] px-2 py-0.5 text-[11.5px] text-[var(--muted)]">
            {matter.orgUnit}
          </span>
        )}
        <span className="tabular shrink-0 text-[var(--muted)]">
          {matter.conversations.length}
        </span>
      </div>

      {open && hasChildren && (
        <div className="ml-6 space-y-px pl-1">
          {matter.conversations.map((c) => (
            <button
              key={c.conversationId}
              type="button"
              onClick={() => onOpenConversation?.(c)}
              className="group flex items-baseline gap-2 rounded-lg px-2 py-1 transition-colors hover:bg-[var(--row-hover)]"
            >
              <span className="min-w-0 flex-1 truncate text-[13.5px] text-[var(--fg)]">
                {c.subject || "(no subject)"}
              </span>
              <span className="shrink-0 truncate text-[12.5px] text-[var(--muted)]">
                {c.from}
              </span>
            </button>
          ))}
          {matter.yields.map((y, i) => (
            <p
              key={i}
              className="px-2 py-1 text-[13px] text-[var(--brand-strong)]"
            >
              {y.headline}
            </p>
          ))}
        </div>
      )}
    </div>
  );
}

/* --------------------------------------------------------------- Board --- */

/**
 * The whiteboard proper: every matter is one bare name under its section
 * heading, sections flowing down two or three tracks.
 *
 * The density is the point. A board of cards shows a dozen matters per screen;
 * a hundred matters as plain lines shows the whole business at once, which is
 * what a whiteboard is for. Detail lives one click away rather than on the
 * board itself.
 */
function AtlasBoard({
  sections,
  collapsed,
  toggle,
  onOpenMatter,
  onOpenConversation,
}: {
  sections: AtlasSection[];
  collapsed: Set<string>;
  toggle: (id: string) => void;
  onOpenMatter: (matter: MatterCard) => void;
  onOpenConversation?: (conversation: ConversationRow) => void;
}) {
  const [tracks, setTracks] = useState(3);
  useEffect(() => {
    const compute = () =>
      setTracks(
        window.innerWidth >= 1280 ? 3 : window.innerWidth >= 768 ? 2 : 1,
      );
    compute();
    window.addEventListener("resize", compute);
    return () => window.removeEventListener("resize", compute);
  }, []);

  // Greedy balance: each section joins the shortest track, so the columns end
  // level instead of one running far past the others. A heading costs a row, so
  // a section of one matter is not free.
  const buckets = useMemo(() => {
    const columns: AtlasSection[][] = Array.from({ length: tracks }, () => []);
    const heights = new Array<number>(tracks).fill(0);
    for (const section of sections) {
      let shortest = 0;
      for (let i = 1; i < tracks; i++) {
        if (heights[i] < heights[shortest]) shortest = i;
      }
      columns[shortest].push(section);
      heights[shortest] += section.matters.length + 1;
    }
    return columns;
  }, [sections, tracks]);

  return (
    <div
      className="grid items-start gap-x-10 gap-y-1 px-4 py-3"
      style={{ gridTemplateColumns: `repeat(${tracks}, minmax(0, 1fr))` }}
    >
      {buckets.map((column, i) => (
        <div key={i} className="min-w-0">
          {column.map((section) => (
            <section key={section.name} className="mb-7">
              <h2 className="atlas-heading px-1.5">
                {sectionLabel(section.name)}
                <span className="tabular"> · {section.matters.length}</span>
              </h2>
              <ul className="mt-1.5">
                {section.matters.map((matter) => (
                  <BoardMatter
                    key={matter.matterId}
                    matter={matter}
                    open={!collapsed.has(`m:${matter.matterId}`)}
                    onToggle={() => toggle(`m:${matter.matterId}`)}
                  onOpenMatter={() => onOpenMatter(matter)}
                  onOpenConversation={onOpenConversation}
                  />
                ))}
              </ul>
            </section>
          ))}
        </div>
      ))}
    </div>
  );
}

/** One line on the whiteboard. Click the name to see what is under it. */
function BoardMatter({
  matter,
  open,
  onToggle,
  onOpenMatter,
  onOpenConversation,
}: {
  matter: MatterCard;
  open: boolean;
  onToggle: () => void;
  onOpenMatter: () => void;
  onOpenConversation?: (conversation: ConversationRow) => void;
}) {
  return (
    <li className="group">
      <div className="atlas-row flex w-full items-baseline gap-1 px-1.5 text-left transition-colors">
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={open}
          aria-label={open ? `Collapse ${matter.shortTitle}` : `Expand ${matter.shortTitle}`}
          className="shrink-0 p-1"
        >
          <Chevron open={open} />
        </button>
        <button
          type="button"
          onClick={onOpenMatter}
          aria-label={`Open matter ${matter.shortTitle}`}
          className="min-w-0 flex-1 text-left text-[length:var(--t-body)] leading-[var(--lh-tight)] text-[var(--fg-strong)]"
        >
          {matter.shortTitle}
        </button>
        {matter.conversations.length > 1 && (
          <span className="tabular shrink-0 text-[var(--muted)]">
            {matter.conversations.length}
          </span>
        )}
      </div>
      {open && (
        <ul className="mb-2 ml-1.5 space-y-px pl-3">
          {matter.conversations.map((c) => (
            <li key={c.conversationId}>
              <button
                type="button"
                onClick={() => onOpenConversation?.(c)}
                className="atlas-row block w-full truncate px-1.5 text-left text-[length:var(--t-small)] text-[var(--muted)] transition-colors hover:text-[var(--fg)]"
              >
                {c.subject || "(no subject)"}
                <span className="opacity-70"> — {c.from}</span>
              </button>
            </li>
          ))}
          {matter.yields.map((y, i) => (
            <li
              key={`y${i}`}
              className="atlas-row px-1.5 text-[length:var(--t-small)] text-[var(--brand-strong)]"
            >
              {y.headline}
            </li>
          ))}
        </ul>
      )}
    </li>
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
            <p className="atlas-detail-kicker">{matter.section}</p>
            <h2 id="atlas-detail-title">{matter.shortTitle}</h2>
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
