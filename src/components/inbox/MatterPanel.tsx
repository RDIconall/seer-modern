"use client";

import { useEffect, useRef, useState } from "react";
import { Archive, ChevronLeft, MoreHorizontal } from "lucide-react";
import type { Matter } from "@/lib/inbox/matters";
import { formatAmount } from "@/lib/crm/registry";

/**
 * MATTER PANEL — one matter, on a phone first.
 *
 * The board shows a name; this screen answers "what is this and what do I
 * do next". Everything here earns its line: the next move leads, the state
 * explains it, the conversations are readable rows rather than two columns
 * of truncated text. Administration (rename, re-file, settle) moves into a
 * menu so the title gets the width it needs.
 */

export type PanelRow = { id: string; threadId: string };

/** "3h", "2d", "Jun 4" — a conversation without recency can't be judged. */
function shortTime(iso?: string): string {
  if (!iso) return "";
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return "";
  const mins = Math.floor((Date.now() - t) / 60_000);
  if (mins < 60) return `${Math.max(1, mins)}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d`;
  return new Date(t).toLocaleDateString([], { month: "short", day: "numeric" });
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

/** The row's line is "Who — what happened"; the name is shown separately. */
function meaningOf(line: string, from: string): string {
  const dash = line.indexOf(" — ");
  const rest = dash > -1 ? line.slice(dash + 3) : line;
  return rest.toLowerCase().startsWith(from.toLowerCase())
    ? rest.slice(from.length).replace(/^[\s—-]+/, "")
    : rest;
}

export function MatterPanel({
  m,
  functions,
  settled,
  onOpen,
  onClose,
  onFix,
  onAtlasAction,
  onRename,
  onSettle,
}: {
  m: Matter;
  functions: string[];
  settled: boolean;
  onOpen: (id: string) => void;
  onClose: () => void;
  onFix?: (matterId: string, orgUnit: string) => void;
  onAtlasAction?: (rows: PanelRow[], action: "archive" | "trash") => void;
  onRename?: (matterId: string, title: string) => void;
  onSettle?: (matterId: string, settled: boolean) => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [fixing, setFixing] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [draft, setDraft] = useState(m.title);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!menuOpen) return;
    const onDown = (e: MouseEvent) => {
      if (!menuRef.current?.contains(e.target as Node)) setMenuOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [menuOpen]);

  const emails = m.emails ?? [];
  const hasNext = Boolean(m.nextAction && !/^none/i.test(m.nextAction));
  const owner =
    m.owner === "you" ? "Yours" : m.owner === "them" ? "Their court" : "Team";
  const crmLine = m.crm
    ? [
        m.crm.code,
        m.crm.account,
        m.crm.amount ? formatAmount(m.crm.amount) : "",
        m.crm.stage,
        m.crm.status,
        m.crm.closeDate ? `closes ${m.crm.closeDate}` : "",
      ]
        .filter(Boolean)
        .join(" · ")
    : "";

  return (
    <div className="flex h-full flex-col overflow-hidden bg-[var(--bg)]">
      <header className="shrink-0 border-b border-[var(--border)] px-2 pt-1">
        <div className="flex items-center justify-between">
          <button
            type="button"
            onClick={onClose}
            aria-label="Back"
            className="flex h-11 w-11 items-center justify-center rounded-full text-[var(--muted)] hover:bg-[var(--row-hover)] hover:text-[var(--fg-strong)]"
          >
            <ChevronLeft className="h-5 w-5" />
          </button>
          <div ref={menuRef} className="relative">
            <button
              type="button"
              onClick={() => setMenuOpen((v) => !v)}
              aria-label="Matter actions"
              aria-expanded={menuOpen}
              className="flex h-11 w-11 items-center justify-center rounded-full text-[var(--muted)] hover:bg-[var(--row-hover)] hover:text-[var(--fg-strong)]"
            >
              <MoreHorizontal className="h-5 w-5" />
            </button>
            {menuOpen ? (
              <div className="absolute right-0 top-11 z-20 w-52 overflow-hidden rounded-lg border border-[var(--border)] bg-[var(--card)] shadow-lg">
                {onRename ? (
                  <button
                    type="button"
                    onClick={() => {
                      setDraft(m.title);
                      setRenaming(true);
                      setMenuOpen(false);
                    }}
                    className="block w-full px-4 py-3 text-left text-[14px] text-[var(--fg)] hover:bg-[var(--row-hover)]"
                  >
                    Rename
                  </button>
                ) : null}
                {onFix ? (
                  <button
                    type="button"
                    onClick={() => {
                      setFixing(true);
                      setMenuOpen(false);
                    }}
                    className="block w-full px-4 py-3 text-left text-[14px] text-[var(--fg)] hover:bg-[var(--row-hover)]"
                  >
                    Change category
                  </button>
                ) : null}
                {onSettle ? (
                  <button
                    type="button"
                    onClick={() => {
                      onSettle(m.id, !settled);
                      setMenuOpen(false);
                    }}
                    className="block w-full border-t border-[var(--border)] px-4 py-3 text-left text-[14px] text-[var(--fg)] hover:bg-[var(--row-hover)]"
                  >
                    {settled ? "Reopen matter" : "Settle matter"}
                  </button>
                ) : null}
              </div>
            ) : null}
          </div>
        </div>

        <div className="px-2 pb-3">
          {renaming && onRename ? (
            <input
              autoFocus
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onBlur={() => setRenaming(false)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && draft.trim()) {
                  onRename(m.id, draft.trim());
                  setRenaming(false);
                }
                if (e.key === "Escape") {
                  setDraft(m.title);
                  setRenaming(false);
                }
              }}
              className="w-full rounded border border-[var(--border)] bg-[var(--bg)] px-2 py-1 text-[17px] font-bold"
            />
          ) : (
            <h2 className="text-[17px] font-bold leading-6 text-[var(--fg-strong)]">
              {m.title}
            </h2>
          )}
          <p className="mt-0.5 text-[12px] text-[var(--nav-muted)]">
            {fixing && onFix ? (
              <select
                autoFocus
                defaultValue={orgRoot(m.orgUnit, functions)}
                onBlur={() => setFixing(false)}
                onChange={(e) => {
                  onFix(m.id, e.target.value);
                  setFixing(false);
                }}
                className="rounded border border-[var(--border)] bg-[var(--bg)] px-1 py-0.5 text-[12px]"
              >
                {functions.map((f) => (
                  <option key={f} value={f}>
                    {f}
                  </option>
                ))}
              </select>
            ) : (
              <>
                {m.orgUnit}
                {emails.length
                  ? ` · ${emails.length} conversation${emails.length === 1 ? "" : "s"}`
                  : ""}
                {settled ? " · settled" : ""}
              </>
            )}
          </p>
        </div>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {m.status === "looks-closed" && !settled && onSettle ? (
          <section className="border-b border-[var(--border)] bg-[var(--card)] px-4 py-3">
            <p className="text-[17px] font-bold text-[var(--fg-strong)]">
              This looks finished
            </p>
            <p className="mt-0.5 text-[14px] leading-5 text-[var(--muted)]">
              {m.statusWhy || "The latest evidence says the goal is met."}
            </p>
            <button
              type="button"
              onClick={() => onSettle(m.id, true)}
              className="mt-2 flex min-h-11 items-center rounded-full bg-[var(--brand)] px-4 text-[14px] font-bold text-white"
            >
              Settle matter
            </button>
          </section>
        ) : null}

        {/* The next move leads — it is the reason to open a matter. */}
        <section className="border-b border-[var(--border)] px-4 py-3">
          <p className="text-[12px] text-[var(--nav-muted)]">
            Next · {owner}
          </p>
          <p className="mt-0.5 text-[17px] font-bold leading-6 text-[var(--fg-strong)]">
            {hasNext ? m.nextAction : "Waiting on someone else"}
          </p>
        </section>

        <section className="border-b border-[var(--border)] px-4 py-3">
          <p className="text-[14px] leading-5 text-[var(--muted)]">
            {m.narrative}
          </p>
          {m.goal && m.goal !== m.narrative ? (
            <p className="mt-1 text-[14px] leading-5 text-[var(--muted)]">
              Done when: {m.goal}
            </p>
          ) : null}
          {crmLine ? (
            <p className="mt-1 text-[14px] leading-5 text-[var(--fg)]">
              {crmLine}
            </p>
          ) : null}
          {m.people?.length ? (
            <p className="mt-1 text-[12px] leading-5 text-[var(--nav-muted)]">
              {m.people
                .slice(0, 6)
                .map((p) => p.name.split(" ")[0])
                .join(" · ")}
            </p>
          ) : null}
        </section>

        <ul>
          {emails.map((e) => {
            const when = shortTime(e.at);
            const meaning = meaningOf(e.line, e.from);
            return (
              <li
                key={e.id}
                className="flex items-start gap-1 border-b border-[var(--border)]"
              >
                <button
                  type="button"
                  onClick={() => onOpen(e.id)}
                  className="min-w-0 flex-1 px-4 py-3 text-left"
                >
                  <span className="flex items-baseline gap-2">
                    <span className="min-w-0 flex-1 truncate text-[14px] font-bold text-[var(--fg-strong)]">
                      {e.from}
                    </span>
                    {e.count && e.count > 1 ? (
                      <span className="shrink-0 text-[12px] text-[var(--nav-muted)]">
                        {e.count}
                      </span>
                    ) : null}
                    {when ? (
                      <span className="shrink-0 text-[12px] text-[var(--nav-muted)]">
                        {when}
                      </span>
                    ) : null}
                  </span>
                  <span className="mt-0.5 line-clamp-2 block text-[14px] leading-5 text-[var(--muted)]">
                    {e.suggestion || meaning}
                  </span>
                </button>
                {onAtlasAction ? (
                  <button
                    type="button"
                    onClick={() =>
                      onAtlasAction([{ id: e.id, threadId: e.threadId }], "archive")
                    }
                    aria-label={`Archive conversation with ${e.from}`}
                    className="mr-1 mt-2 flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-[var(--nav-muted)] hover:bg-[var(--row-hover)] hover:text-[var(--fg)]"
                  >
                    <Archive className="h-4 w-4" />
                  </button>
                ) : null}
              </li>
            );
          })}
        </ul>
      </div>
    </div>
  );
}
