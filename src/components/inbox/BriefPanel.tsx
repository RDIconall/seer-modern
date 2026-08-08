"use client";

import { useMemo, useState } from "react";
import type { Brief, FiledEmail, Matter } from "@/lib/inbox/matters";
import { formatAmount } from "@/lib/crm/registry";

/**
 * ATLAS — the whole inbox as a living corpus, filed into the user's own org
 * chart. One view: by organization. Everything sits at the same level;
 * a matter opens into a project card (goal, next move, per-email
 * suggestion). Rows act on whole conversations, like Gmail.
 */

export type AtlasRow = { id: string; threadId: string };

type Row =
  | { kind: "matter"; key: string; matter: Matter }
  | { kind: "filed"; key: string; filed: FiledEmail };

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

/** you = solid marker in the one accent; them/team = quiet glyphs */
function ownerGlyph(owner: string): { glyph: string; cls: string } {
  if (owner === "you") return { glyph: "●", cls: "text-[var(--brand)]" };
  if (owner === "them") return { glyph: "◌", cls: "text-[var(--muted)]" };
  return { glyph: "–", cls: "text-[var(--nav-muted)]" };
}

function RowActions({
  rows,
  onAction,
}: {
  rows: AtlasRow[];
  onAction: (rows: AtlasRow[], action: "archive" | "trash") => void;
}) {
  return (
    <span className="ml-1 hidden shrink-0 gap-1.5 group-hover:flex">
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          onAction(rows, "archive");
        }}
        title="Archive the whole thread"
        className="text-[11px] text-[var(--nav-muted)] hover:text-[var(--fg)]"
      >
        archive
      </button>
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          onAction(rows, "trash");
        }}
        title="Delete the whole thread"
        className="text-[11px] text-[var(--nav-muted)] hover:text-[#d63b2f]"
      >
        delete
      </button>
    </span>
  );
}

function MatterCard({
  m,
  onOpen,
  functions,
  onFix,
  onClose,
  onAction,
  onRename,
}: {
  m: Matter;
  onOpen: (id: string) => void;
  functions: string[];
  onFix?: (matterId: string, orgUnit: string) => void;
  onClose: () => void;
  onAction?: (rows: AtlasRow[], action: "archive" | "trash") => void;
  onRename?: (matterId: string, title: string) => void;
}) {
  const [fixing, setFixing] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [draft, setDraft] = useState(m.title);
  const allRows: AtlasRow[] = (m.emails ?? []).map((e) => ({
    id: e.id,
    threadId: e.threadId,
  }));

  return (
    <div className="my-1 rounded border border-[var(--border)] bg-[var(--card)] px-3 py-2.5">
      <div className="flex items-baseline gap-2">
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
            className="min-w-0 flex-1 rounded border border-[var(--border)] bg-[var(--bg)] px-2 py-1 text-[15px] font-bold"
          />
        ) : (
          <h3 className="min-w-0 flex-1 text-[15px] font-bold leading-6 text-[var(--fg-strong)]">
            {m.title}
          </h3>
        )}
        {onRename && !renaming ? (
          <button
            type="button"
            onClick={() => {
              setDraft(m.title);
              setRenaming(true);
            }}
            className="shrink-0 text-[11px] text-[var(--nav-muted)] hover:text-[var(--fg)]"
          >
            rename
          </button>
        ) : null}
        {onAction && allRows.length > 0 ? (
          <button
            type="button"
            onClick={() => onAction(allRows, "archive")}
            className="shrink-0 text-[11px] text-[var(--nav-muted)] hover:text-[var(--fg)]"
          >
            archive all
          </button>
        ) : null}
        <button
          type="button"
          onClick={onClose}
          className="shrink-0 text-[11px] text-[var(--nav-muted)] hover:text-[var(--fg)]"
        >
          close
        </button>
      </div>

      <dl className="mt-1.5 space-y-1 text-[13px] leading-6">
        <div className="flex gap-2">
          <dt className="w-[92px] shrink-0 text-[11px] font-semibold uppercase tracking-wide text-[var(--nav-muted)]">
            Goal
          </dt>
          <dd className="min-w-0 flex-1 text-[var(--fg)]">
            {m.goal || m.narrative}
          </dd>
        </div>
        <div className="flex gap-2">
          <dt className="w-[92px] shrink-0 text-[11px] font-semibold uppercase tracking-wide text-[var(--nav-muted)]">
            State
          </dt>
          <dd className="min-w-0 flex-1 text-[var(--muted)]">{m.narrative}</dd>
        </div>
        <div className="flex gap-2">
          <dt className="w-[92px] shrink-0 text-[11px] font-semibold uppercase tracking-wide text-[var(--nav-muted)]">
            Next
          </dt>
          <dd className="min-w-0 flex-1 font-semibold text-[var(--fg-strong)]">
            {m.nextAction && !/^none/i.test(m.nextAction)
              ? m.nextAction
              : "Nothing — waiting on someone else"}
            <span className="ml-1.5 font-normal text-[var(--muted)]">
              (
              {m.owner === "you"
                ? "yours"
                : m.owner === "them"
                  ? "their court"
                  : "team"}
              )
            </span>
          </dd>
        </div>
        {m.crm ? (
          <div className="flex gap-2">
            <dt className="w-[92px] shrink-0 text-[11px] font-semibold uppercase tracking-wide text-[var(--nav-muted)]">
              Salesforce
            </dt>
            <dd className="min-w-0 flex-1 text-[var(--fg)]">
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
                  · sites: {m.crm.investigators.join(", ")}
                </span>
              ) : null}
            </dd>
          </div>
        ) : null}
        <div className="flex gap-2">
          <dt className="w-[92px] shrink-0 text-[11px] font-semibold uppercase tracking-wide text-[var(--nav-muted)]">
            Filed
          </dt>
          <dd className="min-w-0 flex-1 text-[var(--muted)]">
            {fixing && onFix ? (
              <select
                autoFocus
                defaultValue={orgRoot(m.orgUnit, functions)}
                onBlur={() => setFixing(false)}
                onChange={(e) => {
                  onFix(m.id, e.target.value);
                  setFixing(false);
                }}
                className="rounded border border-[var(--border)] bg-[var(--bg)] px-1 py-0.5 text-[13px]"
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
                title={onFix ? "Wrong place? Fix it — Seer learns" : undefined}
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
          </dd>
        </div>
      </dl>

      <p className="mt-2 text-[11px] font-semibold uppercase tracking-wide text-[var(--nav-muted)]">
        Seer suggests · {m.emails?.length ?? m.emailIds.length} email
        {(m.emails?.length ?? m.emailIds.length) === 1 ? "" : "s"}
      </p>
      <ul className="mt-0.5">
        {(m.emails ?? []).map((e) => (
          <li
            key={e.id}
            className="group flex items-baseline gap-2 text-[13px] leading-6"
          >
            <button
              type="button"
              onClick={() => onOpen(e.id)}
              className="min-w-0 flex-1 truncate text-left text-[var(--fg)] hover:text-[var(--fg-strong)]"
            >
              {e.line}
            </button>
            <span className="shrink-0 text-[11px] text-[var(--muted)]">
              {e.suggestion}
            </span>
            {onAction ? (
              <RowActions
                rows={[{ id: e.id, threadId: e.threadId }]}
                onAction={onAction}
              />
            ) : null}
          </li>
        ))}
      </ul>
    </div>
  );
}

function MatterRow({
  m,
  onOpenCard,
  code,
  onAction,
}: {
  m: Matter;
  onOpenCard: () => void;
  code?: string;
  onAction?: (rows: AtlasRow[], action: "archive" | "trash") => void;
}) {
  const g = ownerGlyph(m.owner);
  const rows: AtlasRow[] = (m.emails ?? []).map((e) => ({
    id: e.id,
    threadId: e.threadId,
  }));
  return (
    <li className="group flex items-baseline gap-1.5">
      <span className={`shrink-0 text-[11px] ${g.cls}`} title={m.owner}>
        {g.glyph}
      </span>
      <button
        type="button"
        onClick={onOpenCard}
        className="min-w-0 flex-1 truncate text-left text-[14px] leading-7"
      >
        {code ? (
          <span className="text-[var(--nav-muted)]">{code} </span>
        ) : null}
        <span className="font-semibold text-[var(--fg-strong)]">{m.title}</span>
        {m.crm?.amount ? (
          <span className="font-semibold text-[var(--brand)]">
            {" "}
            {formatAmount(m.crm.amount)}
          </span>
        ) : null}
        <span className="text-[var(--muted)]"> — {m.narrative}</span>
      </button>
      {onAction && rows.length > 0 ? (
        <RowActions rows={rows} onAction={onAction} />
      ) : null}
    </li>
  );
}

function FiledRow({
  f,
  onOpen,
  code,
  picked,
  onPick,
  onAction,
}: {
  f: FiledEmail;
  onOpen: (id: string) => void;
  code?: string;
  picked: boolean;
  onPick: (id: string) => void;
  onAction?: (rows: AtlasRow[], action: "archive" | "trash") => void;
}) {
  return (
    <li className="group flex items-baseline gap-1.5">
      <input
        type="checkbox"
        checked={picked}
        onChange={() => onPick(f.emailId)}
        aria-label="Select"
        className="h-3 w-3 shrink-0 translate-y-[2px] accent-[var(--brand)]"
      />
      <button
        type="button"
        onClick={() => onOpen(f.emailId)}
        className="min-w-0 flex-1 truncate text-left text-[13px] leading-7 text-[var(--muted)] hover:text-[var(--fg)]"
      >
        {code ? <span className="text-[var(--nav-muted)]">{code} </span> : null}
        {f.line}
      </button>
      {f.suggestion ? (
        <span className="shrink-0 text-[11px] text-[var(--nav-muted)]">
          {f.suggestion}
        </span>
      ) : null}
      {onAction ? (
        <RowActions
          rows={[{ id: f.emailId, threadId: f.threadId }]}
          onAction={onAction}
        />
      ) : null}
    </li>
  );
}

export function BriefPanel({
  brief,
  building,
  onRebuild,
  onOpen,
  onClearHeadlines,
  onFixMatter,
  onAtlasAction,
  onRenameMatter,
  onCreateMatter,
  full,
}: {
  brief: Brief | null;
  building: boolean;
  onRebuild: () => void;
  onOpen: (id: string) => void;
  onClearHeadlines: (ids: { id: string; threadId: string }[]) => void;
  onFixMatter?: (matterId: string, orgUnit: string) => void;
  onAtlasAction?: (rows: AtlasRow[], action: "archive" | "trash") => void;
  onRenameMatter?: (matterId: string, title: string) => void;
  onCreateMatter?: (title: string, emailIds: string[]) => void;
  /** Atlas mode: full-page scale, org-only, everything at one level */
  full?: boolean;
}) {
  const [openMatter, setOpenMatter] = useState<string | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [naming, setNaming] = useState(false);
  const [newTitle, setNewTitle] = useState("");
  const functions = useMemo(() => brief?.functions ?? [], [brief]);

  const togglePick = (id: string) =>
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  /** function → sub-branch → rows, all pre-flattened for rendering */
  const sections = useMemo(() => {
    if (!brief) return [];
    const byFn = new Map<string, Map<string, Row[]>>();
    const put = (fn: string, sub: string, row: Row) => {
      const subs = byFn.get(fn) ?? new Map<string, Row[]>();
      byFn.set(fn, subs);
      const rows = subs.get(sub) ?? [];
      rows.push(row);
      subs.set(sub, rows);
    };
    for (const m of brief.matters) {
      put(orgRoot(m.orgUnit, functions), m.subUnit || "", {
        kind: "matter",
        key: m.id,
        matter: m,
      });
    }
    for (const f of brief.filed ?? []) {
      put(orgRoot(f.orgUnit, functions), f.subUnit || "", {
        kind: "filed",
        key: f.emailId,
        filed: f,
      });
    }

    const order = [...functions, ...byFn.keys()].filter(
      (v, i, a) => a.indexOf(v) === i,
    );
    return order
      .filter((fn) => byFn.has(fn))
      .map((fn) => {
        const subs = [...byFn.get(fn)!.entries()]
          .map(([label, rows]) => ({
            label,
            rows: [...rows].sort(
              (a, b) =>
                (a.kind === "matter" ? 0 : 1) - (b.kind === "matter" ? 0 : 1),
            ),
          }))
          .sort(
            (a, b) =>
              b.rows.filter((r) => r.kind === "matter").length -
                a.rows.filter((r) => r.kind === "matter").length ||
              b.rows.length - a.rows.length,
          );
        const count = subs.reduce((n, s) => n + s.rows.length, 0);
        return { fn, subs, count };
      });
  }, [brief, functions]);

  const digestCount =
    brief?.digest?.themes.reduce((n, t) => n + t.emailIds.length, 0) ??
    brief?.headlines.length ??
    0;
  const inMatters = brief
    ? new Set(
        [...brief.matters, ...(brief.pinned ?? [])].flatMap((m) => m.emailIds),
      ).size
    : 0;
  const filedCount = brief?.filed?.length ?? 0;
  const accounted = inMatters + filedCount + digestCount;
  const total = brief?.totalInbox ?? accounted;
  const providerCount = brief?.providerTotal?.messages || undefined;
  const short = Math.max(0, (providerCount ?? total) - accounted);

  if (!full) return null;

  const renderRows = (rows: Row[], subLabel: string, showCode: boolean) =>
    rows.map((r) =>
      r.kind === "matter" ? (
        openMatter === r.key ? (
          <li key={r.key}>
            <MatterCard
              m={r.matter}
              onOpen={onOpen}
              functions={functions}
              onFix={onFixMatter}
              onAction={onAtlasAction}
              onRename={onRenameMatter}
              onClose={() => setOpenMatter(null)}
            />
          </li>
        ) : (
          <MatterRow
            key={r.key}
            m={r.matter}
            code={showCode ? subLabel : undefined}
            onAction={onAtlasAction}
            onOpenCard={() => setOpenMatter(r.key)}
          />
        )
      ) : (
        <FiledRow
          key={r.key}
          f={r.filed}
          code={showCode ? subLabel : undefined}
          onOpen={onOpen}
          picked={picked.has(r.filed.emailId)}
          onPick={togglePick}
          onAction={onAtlasAction}
        />
      ),
    );

  return (
    <div className="border-b border-[var(--border)]">
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 px-4 pt-2.5">
        <span className="text-[11px] font-bold uppercase tracking-widest text-[var(--fg-strong)]">
          Atlas
        </span>
        {brief ? (
          <>
            <span className="text-[12px] font-semibold text-[var(--fg-strong)]">
              {accounted} of {providerCount ?? total} in the inbox
              {brief.totalThreads ? ` · ${brief.totalThreads} threads` : ""}
            </span>
            <span
              className={`text-[12px] ${short === 0 ? "text-[var(--muted)]" : "font-semibold text-[#b45309]"}`}
            >
              {short === 0
                ? "· every message placed"
                : `· ${short} not read yet`}
            </span>
            <span className="text-[11px] text-[var(--nav-muted)]">
              · {brief.matters.length} matters · {filedCount} filed ·{" "}
              {digestCount} to clear
              {brief.unread ? ` · ${brief.unread} still being read` : ""}
              {building ? " · reading…" : ""}
            </span>
          </>
        ) : null}
      </div>

      {brief ? (
        <div className="px-4 pb-3 pt-1">
          {/* PINNED — the signature queue leads; nothing outranks your pen */}
          {(brief.pinned ?? []).map((m) =>
            openMatter === m.id ? (
              <MatterCard
                key={m.id}
                m={m}
                onOpen={onOpen}
                functions={functions}
                onFix={onFixMatter}
                onAction={onAtlasAction}
                onRename={onRenameMatter}
                onClose={() => setOpenMatter(null)}
              />
            ) : (
              <ul key={m.id} className="mt-1">
                <MatterRow
                  m={m}
                  onAction={onAtlasAction}
                  onOpenCard={() => setOpenMatter(m.id)}
                />
              </ul>
            ),
          )}

          {sections.map((s) => (
            <section key={s.fn} className="mt-2.5">
              <h2 className="text-[11px] font-bold uppercase tracking-widest text-[var(--fg-strong)]">
                {s.fn}{" "}
                <span className="text-[var(--nav-muted)]">· {s.count}</span>
              </h2>
              {s.subs.map((sub) => {
                // A heading above a single row is noise — fold the code into
                // the row instead of spending a line on it.
                const fold = sub.rows.length === 1 || !sub.label;
                return (
                  <div key={sub.label || "_"}>
                    {!fold && s.subs.length > 1 ? (
                      <h3 className="mt-1 text-[11px] font-semibold uppercase tracking-wide text-[var(--nav-muted)]">
                        {sub.label}{" "}
                        <span className="font-normal">· {sub.rows.length}</span>
                      </h3>
                    ) : null}
                    <ul>{renderRows(sub.rows, sub.label, fold)}</ul>
                  </div>
                );
              })}
            </section>
          ))}

          {/* THE REST — categories only, no essay */}
          {digestCount > 0 ? (
            <section className="mt-4 border-t border-[var(--border)] pt-2">
              <div className="flex items-baseline gap-2">
                <h2 className="text-[11px] font-bold uppercase tracking-widest text-[var(--fg-strong)]">
                  The rest, summarized{" "}
                  <span className="text-[var(--nav-muted)]">
                    · {digestCount}
                  </span>
                </h2>
                <span className="flex-1" />
                <button
                  type="button"
                  onClick={() => onClearHeadlines(brief.headlineIds)}
                  className="text-[11px] text-[var(--nav-muted)] underline decoration-[var(--border)] underline-offset-2 hover:text-[var(--fg)]"
                >
                  clear all {brief.headlineIds.length}
                </button>
              </div>
              <ul className="mt-0.5">
                {(brief.digest?.themes ?? []).map((t) => (
                  <li key={t.theme} className="text-[13px] leading-7">
                    <span className="font-semibold text-[var(--fg-strong)]">
                      {t.theme}
                    </span>
                    <span className="text-[var(--nav-muted)]">
                      {" "}
                      ({t.emailIds.length})
                    </span>
                    <span className="text-[var(--muted)]"> — {t.line}</span>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
        </div>
      ) : (
        <p className="px-4 pb-3 pt-1 text-[12px] text-[var(--muted)]">
          {building
            ? "Reading the inbox…"
            : "No brief yet — Seer builds it in the background."}
        </p>
      )}

      {/* Selection bar: act on threads, or make the selection a matter */}
      {picked.size > 0 ? (
        <div className="sticky bottom-0 z-10 flex flex-wrap items-center gap-2 border-t border-[var(--border)] bg-[var(--card)] px-4 py-2">
          <span className="text-[12px] font-semibold">
            {picked.size} selected
          </span>
          {naming ? (
            <input
              autoFocus
              value={newTitle}
              onChange={(e) => setNewTitle(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && newTitle.trim() && onCreateMatter) {
                  onCreateMatter(newTitle.trim(), [...picked]);
                  setNewTitle("");
                  setNaming(false);
                  setPicked(new Set());
                }
                if (e.key === "Escape") setNaming(false);
              }}
              placeholder="Name the matter, then Enter"
              className="min-w-[220px] flex-1 rounded border border-[var(--border)] bg-[var(--bg)] px-2 py-1 text-[13px]"
            />
          ) : (
            <>
              {onCreateMatter ? (
                <button
                  type="button"
                  onClick={() => setNaming(true)}
                  className="rounded-full bg-[var(--primary)] px-3 py-1 text-[12px] font-semibold text-white"
                >
                  New matter
                </button>
              ) : null}
              {onAtlasAction ? (
                <>
                  <button
                    type="button"
                    onClick={() => {
                      const rows = (brief?.filed ?? [])
                        .filter((f) => picked.has(f.emailId))
                        .map((f) => ({ id: f.emailId, threadId: f.threadId }));
                      onAtlasAction(rows, "archive");
                      setPicked(new Set());
                    }}
                    className="rounded-full border border-[var(--border)] px-3 py-1 text-[12px] font-semibold"
                  >
                    Archive threads
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      const rows = (brief?.filed ?? [])
                        .filter((f) => picked.has(f.emailId))
                        .map((f) => ({ id: f.emailId, threadId: f.threadId }));
                      onAtlasAction(rows, "trash");
                      setPicked(new Set());
                    }}
                    className="rounded-full px-3 py-1 text-[12px] font-semibold text-[#d63b2f]"
                  >
                    Delete threads
                  </button>
                </>
              ) : null}
            </>
          )}
          <button
            type="button"
            onClick={() => setPicked(new Set())}
            className="ml-auto text-[11px] text-[var(--nav-muted)]"
          >
            clear
          </button>
        </div>
      ) : null}

      {/* onRebuild stays wired for the background sync's manual escape hatch */}
      <button type="button" onClick={onRebuild} className="hidden" aria-hidden />
    </div>
  );
}
