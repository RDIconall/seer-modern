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

function sectionLabel(name: string): string {
  if (name === "unfiled") return "Unfiled";
  return name.charAt(0).toUpperCase() + name.slice(1);
}

export function Atlas({ view }: { view: InboxView }) {
  const [mode, setMode] = useState<Mode>("list");
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

function AtlasBoard({
  sections,
  collapsed,
  toggle,
}: {
  sections: AtlasSection[];
  collapsed: Set<string>;
  toggle: (id: string) => void;
}) {
  return (
    // items-start: a column is as tall as its own work. Stretching them all to
    // the tallest leaves dead space under the short ones and reads as unfinished.
    <div className="flex snap-x items-start gap-3 overflow-x-auto px-4 py-3">
      {sections.map((section) => {
        const sectionId = `s:${section.name}`;
        const open = !collapsed.has(sectionId);
        return (
          <div
            key={section.name}
            className="flex w-[280px] shrink-0 snap-start flex-col rounded-xl border border-[var(--border)] bg-[var(--card)]"
          >
            <button
              type="button"
              onClick={() => toggle(sectionId)}
              aria-expanded={open}
              className="flex items-center gap-1.5 border-b border-[var(--border)] px-3 py-2 text-left"
            >
              <Chevron open={open} />
              <span className="min-w-0 flex-1 truncate text-[13px] font-bold text-[var(--fg-strong)]">
                {sectionLabel(section.name)}
              </span>
              <span className="text-[12px] text-[var(--fg)]">
                {section.matters.length}
              </span>
            </button>

            {open && (
              <div className="flex flex-col gap-2 p-2">
                {section.matters.map((matter) => (
                  <article
                    key={matter.matterId}
                    className="rounded-lg border border-[var(--border)] bg-[var(--bg)] p-2.5"
                  >
                    <h3 className="text-[13.5px] font-bold leading-snug text-[var(--fg-strong)]">
                      {matter.title}
                    </h3>
                    <div className="mt-1.5 flex items-center gap-2 text-[11px] text-[var(--fg)]">
                      {matter.orgUnit && (
                        <span className="rounded-full bg-[var(--brand-soft)] px-2 py-0.5 font-bold uppercase tracking-wide text-[var(--brand-strong)]">
                          {matter.orgUnit}
                        </span>
                      )}
                      <span>{matter.conversations.length} threads</span>
                    </div>
                    {matter.yields[0] && (
                      <p className="mt-1.5 border-l-2 border-[var(--brand)] pl-2 text-[12px] text-[var(--fg)]">
                        {matter.yields[0].headline}
                      </p>
                    )}
                  </article>
                ))}
                {section.matters.length === 0 && (
                  <p className="px-1 py-2 text-[12px] text-[var(--fg)]">
                    Nothing here.
                  </p>
                )}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

function Chevron({ open }: { open: boolean }) {
  const Icon = open ? ChevronDown : ChevronRight;
  return <Icon className="h-4 w-4 shrink-0 text-[var(--fg)]" aria-hidden />;
}
