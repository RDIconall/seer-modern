"use client";

import { useState } from "react";
import { ChevronLeft } from "lucide-react";
import type { Matter } from "@/lib/inbox/matters";
import { formatAmount } from "@/lib/crm/registry";

/**
 * MATTER PANEL — the docked detail for one matter. The board shows only a
 * name; everything about the matter lives here: goal, state of play, the
 * next move, Salesforce facts, where it's filed, the people, and the
 * conversations inside (each opens the email). Lifted from the old inline
 * MatterCard so the board itself stays a bare, scannable list.
 */

export type PanelRow = { id: string; threadId: string };

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
  const [fixing, setFixing] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [draft, setDraft] = useState(m.title);
  return (
    <div className="flex h-full flex-col overflow-hidden">
      <header className="flex shrink-0 items-center gap-2 border-b border-[var(--border)] px-4 py-3">
        <button
          type="button"
          onClick={onClose}
          aria-label="Close matter"
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-[var(--muted)] hover:bg-[var(--row-hover)] hover:text-[var(--fg-strong)]"
        >
          <ChevronLeft className="h-5 w-5" />
        </button>
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
            className="min-w-0 flex-1 rounded border border-[var(--border)] bg-[var(--bg)] px-2 py-1 text-[17px] font-bold"
          />
        ) : (
          <h2 className="min-w-0 flex-1 truncate text-[17px] font-bold leading-6 text-[var(--fg-strong)]">
            {m.crm?.code ? (
              <span className="font-normal text-[var(--nav-muted)]">
                {m.crm.code}{" "}
              </span>
            ) : null}
            {m.title}
          </h2>
        )}
        {onRename && !renaming ? (
          <button
            type="button"
            onClick={() => {
              setDraft(m.title);
              setRenaming(true);
            }}
            className="shrink-0 text-[12px] text-[var(--nav-muted)] hover:text-[var(--fg)]"
          >
            rename
          </button>
        ) : null}
        {onSettle ? (
          <button
            type="button"
            onClick={() => onSettle(m.id, !settled)}
            className="shrink-0 text-[12px] text-[var(--nav-muted)] hover:text-[var(--fg)]"
          >
            {settled ? "reopen" : "settle"}
          </button>
        ) : null}
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
        <div className="space-y-1 text-[14px] leading-5">
          <p className="text-[var(--muted)]">{m.narrative}</p>
          {m.goal && m.goal !== m.narrative ? (
            <p className="text-[var(--muted)]">Done when: {m.goal}</p>
          ) : null}
          <p className="font-bold text-[var(--fg-strong)]">
            {m.nextAction && !/^none/i.test(m.nextAction)
              ? m.nextAction
              : "Waiting on someone else"}
            <span className="ml-1.5 font-normal text-[var(--muted)]">
              {m.owner === "you"
                ? "yours"
                : m.owner === "them"
                  ? "their court"
                  : "team"}
            </span>
          </p>
          {m.crm ? (
            <p className="text-[var(--fg)]">
                {[
                  m.crm.code,
                  m.crm.account,
                  m.crm.amount ? formatAmount(m.crm.amount) : "",
                  m.crm.stage,
                  m.crm.status,
                  m.crm.closeDate ? `closes ${m.crm.closeDate}` : "",
                ]
                  .filter(Boolean)
                  .join(" · ")}
                {m.crm.investigators?.length ? (
                  <span className="text-[var(--muted)]">
                    {" "}
                    · {m.crm.investigators.join(", ")}
                  </span>
                ) : null}
            </p>
          ) : null}
          <p className="text-[12px] text-[var(--muted)]">
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
                <button
                  type="button"
                  onClick={() => onFix && setFixing(true)}
                  title={onFix ? "Change category" : undefined}
                  className={
                    onFix
                      ? "underline decoration-dotted decoration-[var(--border)] underline-offset-2 hover:text-[var(--fg)]"
                      : ""
                  }
                >
                  {m.orgUnit}
                  {m.subUnit && !m.orgUnit.includes(m.subUnit)
                    ? ` · ${m.subUnit}`
                    : ""}
                </button>
              )}
              {m.people?.length
                ? ` · ${m.people
                    .slice(0, 5)
                    .map((p) => `${p.name.split(" ")[0]} (${p.relationship})`)
                    .join(", ")}`
                : ""}
          </p>
        </div>

        <p className="mt-3 text-[12px] text-[var(--nav-muted)]">
          {m.emails?.length ?? m.threadIds.length} conversation
          {(m.emails?.length ?? m.threadIds.length) === 1 ? "" : "s"}
        </p>
        <ul className="mt-0.5">
          {(m.emails ?? []).map((e) => (
            <li
              key={e.id}
              className="group flex items-baseline gap-2 text-[14px] leading-5"
            >
              <button
                type="button"
                onClick={() => onOpen(e.id)}
                className="min-w-0 flex-1 truncate text-left text-[var(--fg)] hover:text-[var(--fg-strong)]"
              >
                {e.line}
                {e.count && e.count > 1 ? (
                  <span className="text-[var(--nav-muted)]"> · {e.count}</span>
                ) : null}
              </button>
              <span className="shrink-0 text-[12px] text-[var(--muted)]">
                {e.suggestion}
              </span>
              {onAtlasAction ? (
                <span className="ml-1 hidden shrink-0 gap-1.5 group-hover:flex">
                  <button
                    type="button"
                    onClick={() =>
                      onAtlasAction(
                        [{ id: e.id, threadId: e.threadId }],
                        "archive",
                      )
                    }
                    title="Archive the whole thread"
                    className="text-[12px] text-[var(--nav-muted)] hover:text-[var(--fg)]"
                  >
                    archive
                  </button>
                  <button
                    type="button"
                    onClick={() =>
                      onAtlasAction(
                        [{ id: e.id, threadId: e.threadId }],
                        "trash",
                      )
                    }
                    title="Delete the whole thread"
                    className="text-[12px] text-[var(--nav-muted)] hover:text-[#d63b2f]"
                  >
                    delete
                  </button>
                </span>
              ) : null}
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
