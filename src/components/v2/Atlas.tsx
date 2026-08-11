"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, ChevronRight, ExternalLink } from "lucide-react";
import type { AtlasSection, InboxView, MatterCard } from "@/lib/v2/view/types";
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

export function Atlas({ view }: { view: InboxView }) {
  // The whiteboard is the default: it is the view that shows the whole business
  // at once. The outline is there for working down one section at a time.
  const [mode, setMode] = useState<Mode>("board");
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
      <header className="flex flex-wrap items-baseline justify-between gap-3 border-b border-[var(--border)] px-4 py-3">
        <div>
          <h1 className="text-[17px] font-bold text-[var(--fg-strong)]">
            Whiteboard
          </h1>
          <p className="text-[14px] text-[var(--fg)]">
            {matterCount} matters · {sections.length} sections
          </p>
        </div>
        <div className="flex items-center gap-3 text-[12px]">
          <div className="inline-flex overflow-hidden rounded-md border border-[var(--border)]">
            {(["list", "board"] as Mode[]).map((m) => (
              <button
                key={m}
                type="button"
                onClick={() => setMode(m)}
                aria-pressed={mode === m}
                className={`px-3 py-1 font-bold capitalize ${
                  mode === m
                    ? "bg-[var(--card)] text-[var(--fg-strong)]"
                    : "text-[var(--fg)] hover:bg-[var(--row-hover)]"
                }`}
              >
                {m}
              </button>
            ))}
          </div>
          <button
            type="button"
            onClick={() => collapseAll(allIds)}
            className="font-bold text-[var(--fg)] hover:text-[var(--fg-strong)]"
          >
            Collapse all
          </button>
          <button
            type="button"
            onClick={expandAll}
            className="font-bold text-[var(--fg)] hover:text-[var(--fg-strong)]"
          >
            Expand all
          </button>
        </div>
      </header>

      {mode === "list" ? (
        <AtlasList sections={sections} collapsed={collapsed} toggle={toggle} />
      ) : (
        <AtlasBoard sections={sections} collapsed={collapsed} toggle={toggle} />
      )}
    </section>
  );
}

/* ---------------------------------------------------------------- List --- */

function AtlasList({
  sections,
  collapsed,
  toggle,
}: {
  sections: AtlasSection[];
  collapsed: Set<string>;
  toggle: (id: string) => void;
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
              className="flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-left hover:bg-[var(--row-hover)]"
            >
              <Chevron open={open} />
              <span className="text-[14px] font-bold text-[var(--fg-strong)]">
                {sectionLabel(section.name)}
              </span>
              <span className="text-[12px] text-[var(--fg)]">
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
}: {
  matter: MatterCard;
  collapsed: Set<string>;
  toggle: (id: string) => void;
}) {
  const matterId = `m:${matter.matterId}`;
  const open = !collapsed.has(matterId);
  const hasChildren = matter.conversations.length > 0 || matter.yields.length > 0;

  return (
    <div className="ml-4">
      <div className="flex items-center gap-1.5 rounded-md px-2 py-1 hover:bg-[var(--row-hover)]">
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
        <span className="min-w-0 flex-1 truncate text-[14px] text-[var(--fg-strong)]">
          {matter.title}
        </span>
        {matter.orgUnit && (
          <span className="shrink-0 rounded-full bg-[var(--brand-soft)] px-2 py-0.5 text-[11px] font-bold uppercase tracking-wide text-[var(--brand-strong)]">
            {matter.orgUnit}
          </span>
        )}
        <span className="shrink-0 text-[12px] text-[var(--fg)]">
          {matter.conversations.length}
        </span>
      </div>

      {open && hasChildren && (
        <div className="ml-5 border-l border-[var(--border)] pl-3">
          {matter.conversations.map((c) => (
            <a
              key={c.conversationId}
              href={c.nativeUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="group flex items-baseline gap-2 rounded-md px-2 py-1 hover:bg-[var(--row-hover)]"
            >
              <span className="min-w-0 flex-1 truncate text-[13.5px] text-[var(--fg-strong)]">
                {c.subject || "(no subject)"}
              </span>
              <span className="shrink-0 truncate text-[12px] text-[var(--fg)]">
                {c.from}
              </span>
              <ExternalLink className="h-3 w-3 shrink-0 text-[var(--fg)] opacity-0 group-hover:opacity-100" />
            </a>
          ))}
          {matter.yields.map((y, i) => (
            <p
              key={i}
              className="border-l-2 border-[var(--brand)] px-2 py-1 text-[13px] text-[var(--fg)]"
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
}: {
  sections: AtlasSection[];
  collapsed: Set<string>;
  toggle: (id: string) => void;
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
            <section key={section.name} className="mb-5">
              <h2 className="text-[15px] font-bold text-[var(--fg-strong)]">
                {sectionLabel(section.name)}
                <span className="font-normal text-[var(--muted)]">
                  {" "}
                  · {section.matters.length}
                </span>
              </h2>
              <ul className="mt-1">
                {section.matters.map((matter) => (
                  <BoardMatter
                    key={matter.matterId}
                    matter={matter}
                    open={!collapsed.has(`m:${matter.matterId}`)}
                    onToggle={() => toggle(`m:${matter.matterId}`)}
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
}: {
  matter: MatterCard;
  open: boolean;
  onToggle: () => void;
}) {
  return (
    <li className="group">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        className="flex w-full items-baseline gap-1.5 rounded py-[3px] text-left hover:bg-[var(--row-hover)]"
      >
        <span
          aria-hidden
          className="mt-[7px] h-1 w-1 shrink-0 self-start rounded-full bg-[var(--brand)]"
        />
        <span className="min-w-0 flex-1 text-[14px] leading-5 text-[var(--fg-strong)]">
          {matter.title}
        </span>
        {matter.conversations.length > 1 && (
          <span className="shrink-0 text-[11px] text-[var(--muted)] opacity-0 group-hover:opacity-100">
            {matter.conversations.length}
          </span>
        )}
      </button>
      {open && (
        <ul className="mb-1 ml-3 border-l border-[var(--border)] pl-2.5">
          {matter.conversations.map((c) => (
            <li key={c.conversationId}>
              <a
                href={c.nativeUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="block truncate py-[2px] text-[12.5px] text-[var(--fg)] hover:underline"
              >
                {c.subject || "(no subject)"}
                <span className="text-[var(--muted)]"> — {c.from}</span>
              </a>
            </li>
          ))}
          {matter.yields.map((y, i) => (
            <li
              key={`y${i}`}
              className="py-[2px] text-[12.5px] text-[var(--brand-strong)]"
            >
              {y.headline}
            </li>
          ))}
        </ul>
      )}
    </li>
  );
}

function Chevron({ open }: { open: boolean }) {
  const Icon = open ? ChevronDown : ChevronRight;
  return <Icon className="h-4 w-4 shrink-0 text-[var(--fg)]" aria-hidden />;
}
