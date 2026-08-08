"use client";

import { useMemo, useState } from "react";
import type { Brief, FiledEmail, Matter } from "@/lib/inbox/matters";
import { formatAmount } from "@/lib/crm/registry";

/**
 * ATLAS — the whole inbox as a living corpus, filed into the user's own
 * org chart. One view: by organization. Everything sits at the same
 * level, visible without clicking; a matter opens into a project card
 * (goal, next move, and what Seer suggests per email).
 */

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

function MatterCard({
  m,
  onOpen,
  functions,
  onFix,
  onClose,
}: {
  m: Matter;
  onOpen: (id: string) => void;
  functions: string[];
  onFix?: (matterId: string, orgUnit: string) => void;
  onClose: () => void;
}) {
  const [fixing, setFixing] = useState(false);
  return (
    <div className="my-1 rounded border border-[var(--border)] bg-[var(--card)] px-3 py-2.5">
      <div className="flex items-baseline gap-2">
        <h3 className="min-w-0 flex-1 text-[15px] font-bold leading-6 text-[var(--fg-strong)]">
          {m.title}
        </h3>
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
              ({m.owner === "you" ? "yours" : m.owner === "them" ? "their court" : "team"})
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
          <li key={e.id} className="flex items-baseline gap-2 text-[13px] leading-6">
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
          </li>
        ))}
        {!m.emails?.length
          ? m.emailIds.map((id) => (
              <li key={id}>
                <button
                  type="button"
                  onClick={() => onOpen(id)}
                  className="text-[13px] leading-6 text-[var(--muted)] underline decoration-[var(--border)] underline-offset-2 hover:text-[var(--fg)]"
                >
                  open email
                </button>
              </li>
            ))
          : null}
      </ul>
    </div>
  );
}

function MatterRow({
  m,
  onOpenCard,
}: {
  m: Matter;
  onOpenCard: () => void;
}) {
  const g = ownerGlyph(m.owner);
  return (
    <li className="flex items-baseline gap-1.5">
      <span className={`shrink-0 text-[11px] ${g.cls}`} title={m.owner}>
        {g.glyph}
      </span>
      <button
        type="button"
        onClick={onOpenCard}
        className="min-w-0 flex-1 truncate text-left text-[14px] leading-7"
      >
        <span className="font-semibold text-[var(--fg-strong)]">{m.title}</span>
        {m.crm?.amount ? (
          <span className="font-semibold text-[var(--brand)]">
            {" "}
            {formatAmount(m.crm.amount)}
          </span>
        ) : null}
        <span className="text-[var(--muted)]"> — {m.narrative}</span>
      </button>
    </li>
  );
}

function FiledRow({
  f,
  onOpen,
}: {
  f: FiledEmail;
  onOpen: (id: string) => void;
}) {
  return (
    <li className="flex items-baseline gap-1.5">
      <span className="shrink-0 text-[11px] text-[var(--nav-muted)]">·</span>
      <button
        type="button"
        onClick={() => onOpen(f.emailId)}
        className="min-w-0 flex-1 truncate text-left text-[13px] leading-7 text-[var(--muted)] hover:text-[var(--fg)]"
      >
        {f.line}
      </button>
      {f.suggestion ? (
        <span className="shrink-0 text-[11px] text-[var(--nav-muted)]">
          {f.suggestion}
        </span>
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
  full,
}: {
  brief: Brief | null;
  building: boolean;
  onRebuild: () => void;
  onOpen: (id: string) => void;
  onClearHeadlines: (ids: { id: string; threadId: string }[]) => void;
  onFixMatter?: (matterId: string, orgUnit: string) => void;
  /** Atlas mode: full-page scale, org-only, everything at one level */
  full?: boolean;
}) {
  const [openMatter, setOpenMatter] = useState<string | null>(null);
  const functions = useMemo(() => brief?.functions ?? [], [brief]);

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
          // matters first inside each branch, then the filed trail
          .map(([label, rows]) => ({
            label,
            rows: [...rows].sort(
              (a, b) => (a.kind === "matter" ? 0 : 1) - (b.kind === "matter" ? 0 : 1),
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
    ? new Set(brief.matters.flatMap((m) => m.emailIds)).size
    : 0;
  const filedCount = brief?.filed?.length ?? 0;
  const accounted = inMatters + filedCount + digestCount;
  const total = brief?.totalInbox ?? accounted;
  // The provider's own count is the honest denominator: if Gmail says 512
  // and Atlas placed 500, the gap is stated rather than hidden.
  const providerCount = brief?.providerTotal?.messages || undefined;
  const short = Math.max(0, (providerCount ?? total) - accounted);

  if (!full) {
    // Compact mode is retired — Atlas is the home for all of this.
    return null;
  }

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
              {digestCount} to clear ·{" "}
              {new Date(brief.builtAt).toLocaleTimeString([], {
                hour: "numeric",
                minute: "2-digit",
              })}
              {building ? " · reading…" : ""}
            </span>
          </>
        ) : null}
      </div>

      {brief ? (
        <div className="px-4 pb-3 pt-1">
          {sections.map((s) => (
            <section key={s.fn} className="mt-2.5">
              <h2 className="text-[11px] font-bold uppercase tracking-widest text-[var(--fg-strong)]">
                {s.fn} <span className="text-[var(--nav-muted)]">· {s.count}</span>
              </h2>
              {s.subs.map((sub) => (
                <div key={sub.label || "_"}>
                  {sub.label && s.subs.length > 1 ? (
                    <h3 className="mt-1 text-[11px] font-semibold uppercase tracking-wide text-[var(--nav-muted)]">
                      {sub.label}{" "}
                      <span className="font-normal">· {sub.rows.length}</span>
                    </h3>
                  ) : null}
                  <ul>
                    {sub.rows.map((r) =>
                      r.kind === "matter" ? (
                        openMatter === r.key ? (
                          <li key={r.key}>
                            <MatterCard
                              m={r.matter}
                              onOpen={onOpen}
                              functions={functions}
                              onFix={onFixMatter}
                              onClose={() => setOpenMatter(null)}
                            />
                          </li>
                        ) : (
                          <MatterRow
                            key={r.key}
                            m={r.matter}
                            onOpenCard={() => setOpenMatter(r.key)}
                          />
                        )
                      ) : (
                        <FiledRow key={r.key} f={r.filed} onOpen={onOpen} />
                      ),
                    )}
                  </ul>
                </div>
              ))}
            </section>
          ))}

          {/* THE REST — categories only, no essay */}
          {digestCount > 0 ? (
            <section className="mt-4 border-t border-[var(--border)] pt-2">
              <div className="flex items-baseline gap-2">
                <h2 className="text-[11px] font-bold uppercase tracking-widest text-[var(--fg-strong)]">
                  The rest, summarized{" "}
                  <span className="text-[var(--nav-muted)]">· {digestCount}</span>
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
      {/* onRebuild stays wired for the background sync's manual escape hatch */}
      <button type="button" onClick={onRebuild} className="hidden" aria-hidden />
    </div>
  );
}
