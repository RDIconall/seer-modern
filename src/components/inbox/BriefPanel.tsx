"use client";

import { ChevronDown, ChevronRight } from "lucide-react";
import { useMemo, useState } from "react";
import type { Brief, FiledEmail, Matter } from "@/lib/inbox/matters";

/**
 * ATLAS — the whole inbox as a living corpus, filed into the user's own
 * org format. Checkvist-style outline: typography and indentation carry
 * the structure; the single accent marks what is YOURS. Every email is
 * accounted for: matters, filed, digest, or "needs your call".
 */

type GroupBy = "urgency" | "org" | "relationship";

function groupMatters(
  matters: Matter[],
  by: GroupBy,
): { label: string; matters: Matter[] }[] {
  if (by === "urgency") return [{ label: "", matters }];
  const buckets = new Map<string, Matter[]>();
  for (const m of matters) {
    const key =
      by === "org"
        ? m.orgUnit || "unsorted"
        : m.people?.[0]?.relationship || "no people";
    const list = buckets.get(key) ?? [];
    list.push(m);
    buckets.set(key, list);
  }
  return [...buckets.entries()]
    .map(([label, list]) => ({ label, matters: list }))
    .sort(
      (a, b) =>
        Math.max(...b.matters.map((m) => m.urgency)) -
        Math.max(...a.matters.map((m) => m.urgency)),
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

/** you = solid marker in the one accent; them/team = quiet glyphs */
function ownerGlyph(owner: string): { glyph: string; cls: string } {
  if (owner === "you") return { glyph: "●", cls: "text-[var(--brand)]" };
  if (owner === "them") return { glyph: "◌", cls: "text-[var(--muted)]" };
  return { glyph: "–", cls: "text-[var(--nav-muted)]" };
}

function MatterLine({
  m,
  onOpen,
  full,
  functions,
  onFix,
}: {
  m: Matter;
  onOpen: (id: string) => void;
  full?: boolean;
  functions?: string[];
  onFix?: (matterId: string, orgUnit: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [fixing, setFixing] = useState(false);
  const g = ownerGlyph(m.owner);
  const lowConf = (m.orgConfidence ?? 1) < 0.85;
  return (
    <li>
      <div className="group flex items-baseline gap-1.5">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-label={open ? "Collapse" : "Expand"}
          className="w-4 shrink-0 text-[var(--nav-muted)]"
        >
          {open ? (
            <ChevronDown className="h-3.5 w-3.5" />
          ) : (
            <ChevronRight className="h-3.5 w-3.5" />
          )}
        </button>
        <span className={`shrink-0 text-[11px] ${g.cls}`} title={m.owner}>
          {g.glyph}
        </span>
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className={`min-w-0 flex-1 truncate text-left ${full ? "text-[15px] leading-8" : "text-[13px] leading-6"}`}
        >
          <span className="font-semibold text-[var(--fg-strong)]">
            {m.title}
          </span>
          <span className="text-[var(--muted)]"> — {m.narrative}</span>
        </button>
      </div>
      {open ? (
        <div
          className={`ml-10 space-y-0.5 pb-1.5 ${full ? "text-[13px] leading-6" : "text-[12px] leading-5"}`}
        >
          {m.nextAction && !/^none/i.test(m.nextAction) ? (
            <p className="text-[var(--fg)]">→ {m.nextAction}</p>
          ) : null}
          <p className="text-[var(--muted)]">
            {fixing && functions && onFix ? (
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
                title={onFix ? "Wrong place? Fix it — Seer learns" : undefined}
                className={
                  onFix
                    ? "underline decoration-dotted decoration-[var(--border)] underline-offset-2 hover:text-[var(--fg)]"
                    : ""
                }
              >
                {m.orgUnit}
                {lowConf ? " ?" : ""}
              </button>
            )}
            {m.people?.length
              ? ` · ${m.people
                  .slice(0, 4)
                  .map((p) => `${p.name.split(" ")[0]} (${p.relationship})`)
                  .join(", ")}`
              : ""}
            {" · "}
            <button
              type="button"
              onClick={() => m.emailIds[0] && onOpen(m.emailIds[0])}
              className="underline decoration-[var(--border)] underline-offset-2 hover:text-[var(--fg)]"
            >
              {m.emailIds.length} email{m.emailIds.length === 1 ? "" : "s"}
            </button>
          </p>
        </div>
      ) : null}
    </li>
  );
}

function FiledLines({
  filed,
  onOpen,
}: {
  filed: FiledEmail[];
  onOpen: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <li className="ml-4">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="text-[12px] leading-6 text-[var(--nav-muted)] hover:text-[var(--fg)]"
      >
        {open ? "▾" : "▸"} {filed.length} filed here
      </button>
      {open ? (
        <ul className="ml-3">
          {filed.map((f) => (
            <li key={f.emailId}>
              <button
                type="button"
                onClick={() => onOpen(f.emailId)}
                className="w-full truncate text-left text-[12px] leading-5 text-[var(--muted)] hover:text-[var(--fg)]"
              >
                · {f.line}
              </button>
            </li>
          ))}
        </ul>
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
  /** Atlas mode: full-page scale, org-first, always expanded */
  full?: boolean;
}) {
  const [open, setOpen] = useState(true);
  const [showHeadlines, setShowHeadlines] = useState(Boolean(full));
  const [groupBy, setGroupBy] = useState<GroupBy>(full ? "org" : "urgency");
  const functions = brief?.functions ?? [];

  // Org-first: sections follow the user's own registry order, matters
  // and matter-less filed emails nested under each function.
  const orgSections = useMemo(() => {
    if (!brief || !full || groupBy !== "org") return null;
    const sections = new Map<
      string,
      { matters: Matter[]; filed: FiledEmail[] }
    >();
    const ensure = (key: string) => {
      const s = sections.get(key) ?? { matters: [], filed: [] };
      sections.set(key, s);
      return s;
    };
    for (const m of brief.matters)
      ensure(orgRoot(m.orgUnit, functions)).matters.push(m);
    for (const f of brief.filed ?? [])
      ensure(orgRoot(f.orgUnit, functions)).filed.push(f);
    const ordered: {
      label: string;
      matters: Matter[];
      filed: FiledEmail[];
    }[] = [];
    for (const f of functions) {
      const s = sections.get(f);
      if (s && (s.matters.length || s.filed.length))
        ordered.push({ label: f, ...s });
      sections.delete(f);
    }
    for (const [label, s] of sections) ordered.push({ label, ...s });
    return ordered;
  }, [brief, full, groupBy, functions]);

  const groups = useMemo(
    () => (brief && !orgSections ? groupMatters(brief.matters, groupBy) : []),
    [brief, groupBy, orgSections],
  );

  const digestCount =
    brief?.digest?.themes.reduce((n, t) => n + t.emailIds.length, 0) ??
    brief?.headlines.length ??
    0;
  const inMatters = brief
    ? new Set(brief.matters.flatMap((m) => m.emailIds)).size
    : 0;
  const filedCount = brief?.filed?.length ?? 0;
  const unsure = brief?.unsure ?? [];

  return (
    <div className="border-b border-[var(--border)]">
      {/* header: one quiet line */}
      <div className="flex items-baseline gap-2 px-4 pt-2.5">
        <button
          type="button"
          onClick={() => !full && setOpen((v) => !v)}
          className="flex min-w-0 items-baseline gap-1.5 text-left"
        >
          <span className="text-[11px] font-bold uppercase tracking-widest text-[var(--fg-strong)]">
            {full ? "Atlas" : "Brief"}
          </span>
          {brief ? (
            <span className="text-[11px] text-[var(--nav-muted)]">
              {brief.totalInbox
                ? `${brief.totalInbox} in inbox — all accounted · `
                : ""}
              {new Date(brief.builtAt).toLocaleTimeString([], {
                hour: "numeric",
                minute: "2-digit",
              })}
            </span>
          ) : null}
        </button>
        <span className="flex-1" />
        {brief ? (
          <span className="flex items-baseline gap-2 text-[11px] text-[var(--nav-muted)]">
            {(
              [
                ["urgency", "urgency"],
                ["org", "org"],
                ["relationship", "people"],
              ] as const
            ).map(([key, label]) => (
              <button
                key={key}
                type="button"
                onClick={() => setGroupBy(key)}
                className={
                  groupBy === key
                    ? "text-[var(--fg-strong)] underline underline-offset-4"
                    : "hover:text-[var(--fg)]"
                }
              >
                {label}
              </button>
            ))}
          </span>
        ) : null}
        <button
          type="button"
          disabled={building}
          onClick={onRebuild}
          className="text-[11px] text-[var(--nav-muted)] hover:text-[var(--fg)] disabled:opacity-50"
        >
          {building ? "reading…" : "update"}
        </button>
      </div>

      {open && brief ? (
        <div className="px-4 pb-2.5 pt-1.5">
          {/* coverage: the corpus, accounted for */}
          {full && brief.totalInbox ? (
            <p className="mb-1 text-[12px] text-[var(--nav-muted)]">
              {inMatters} in {brief.matters.length} matters · {filedCount}{" "}
              filed · {digestCount} in the digest
              {unsure.length > 0 ? (
                <span className="text-[var(--brand)]">
                  {" "}
                  · {unsure.length} need your call
                </span>
              ) : null}
            </p>
          ) : null}

          <p
            className={`mb-1.5 max-w-[70ch] text-[var(--muted)] ${full ? "text-[14px] leading-6" : "line-clamp-2 text-[12px] leading-5"}`}
          >
            {brief.summary}
          </p>

          {/* where AI needs the user — the only real triage left */}
          {full && unsure.length > 0 ? (
            <div className="mb-2 rounded border border-[var(--border)] bg-[var(--card)] px-3 py-2">
              <p className="text-[10px] font-semibold uppercase tracking-widest text-[var(--brand)]">
                Needs your call · {unsure.length}
              </p>
              <ul>
                {unsure.map((u) => (
                  <li key={u.emailId}>
                    <button
                      type="button"
                      onClick={() => onOpen(u.emailId)}
                      className="w-full truncate text-left text-[13px] leading-6 text-[var(--fg)] hover:text-[var(--fg-strong)]"
                    >
                      ? {u.question}
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          {orgSections
            ? orgSections.map((s) => (
                <div key={s.label}>
                  <p className="mt-2.5 text-[10px] font-semibold uppercase tracking-widest text-[var(--nav-muted)]">
                    {s.label} ·{" "}
                    {s.matters.length + s.filed.length}
                  </p>
                  <ul>
                    {s.matters.map((m) => (
                      <MatterLine
                        key={m.id}
                        m={m}
                        onOpen={onOpen}
                        full={full}
                        functions={functions}
                        onFix={onFixMatter}
                      />
                    ))}
                    {s.filed.length > 0 ? (
                      <FiledLines filed={s.filed} onOpen={onOpen} />
                    ) : null}
                  </ul>
                </div>
              ))
            : groups.map((g) => (
                <div key={g.label || "all"}>
                  {g.label ? (
                    <p className="mt-2 text-[10px] font-semibold uppercase tracking-widest text-[var(--nav-muted)]">
                      {g.label} · {g.matters.length}
                    </p>
                  ) : null}
                  <ul>
                    {g.matters.map((m) => (
                      <MatterLine
                        key={m.id}
                        m={m}
                        onOpen={onOpen}
                        full={full}
                        functions={functions}
                        onFix={onFixMatter}
                      />
                    ))}
                  </ul>
                </div>
              ))}

          {/* THE DIGEST — the FYI / read-and-delete mass as a whole */}
          {full && brief.digest ? (
            <div className="mt-3 border-t border-[var(--border)] pt-2">
              <div className="flex items-baseline gap-2">
                <p className="text-[10px] font-semibold uppercase tracking-widest text-[var(--nav-muted)]">
                  The rest, summarized · {digestCount}
                </p>
                <span className="flex-1" />
                <button
                  type="button"
                  onClick={() => onClearHeadlines(brief.headlineIds)}
                  className="text-[11px] text-[var(--nav-muted)] underline decoration-[var(--border)] underline-offset-2 hover:text-[var(--fg)]"
                >
                  read it — clear all {brief.headlineIds.length}
                </button>
              </div>
              <p className="mt-1 max-w-[75ch] text-[13px] leading-6 text-[var(--fg)]">
                {brief.digest.summary}
              </p>
              <ul className="mt-1">
                {brief.digest.themes.map((t) => (
                  <DigestTheme
                    key={t.theme}
                    theme={t.theme}
                    line={t.line}
                    emailIds={t.emailIds}
                    onOpen={onOpen}
                    lineFor={(id) =>
                      brief.headlines.find((h) => h.id === id)?.line
                    }
                  />
                ))}
              </ul>
            </div>
          ) : brief.headlines.length > 0 ? (
            <>
              <div className="mt-1.5 flex items-baseline gap-2 text-[12px]">
                <button
                  type="button"
                  onClick={() => setShowHeadlines((v) => !v)}
                  className="text-[var(--nav-muted)] hover:text-[var(--fg)]"
                >
                  {showHeadlines ? "▾" : "▸"} {brief.headlines.length} headlines
                </button>
                <button
                  type="button"
                  onClick={() => onClearHeadlines(brief.headlineIds)}
                  className="text-[var(--nav-muted)] underline decoration-[var(--border)] underline-offset-2 hover:text-[var(--fg)]"
                >
                  glanced — clear all
                </button>
              </div>
              {showHeadlines ? (
                <ul className="ml-4 mt-0.5">
                  {brief.headlines.map((h) => (
                    <li key={h.id}>
                      <button
                        type="button"
                        onClick={() => onOpen(h.id)}
                        className="w-full truncate text-left text-[12px] leading-5 text-[var(--muted)] hover:text-[var(--fg)]"
                      >
                        · {h.line}
                      </button>
                    </li>
                  ))}
                </ul>
              ) : null}
            </>
          ) : null}
        </div>
      ) : null}
      {open && !brief && !building ? (
        <p className="px-4 pb-3 text-[12px] text-[var(--muted)]">
          No brief yet — “update” reads the inbox as one unit.
        </p>
      ) : null}
    </div>
  );
}

function DigestTheme({
  theme,
  line,
  emailIds,
  onOpen,
  lineFor,
}: {
  theme: string;
  line: string;
  emailIds: string[];
  onOpen: (id: string) => void;
  lineFor: (id: string) => string | undefined;
}) {
  const [open, setOpen] = useState(false);
  return (
    <li>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="w-full truncate text-left text-[13px] leading-6"
      >
        <span className="text-[var(--nav-muted)]">{open ? "▾" : "▸"} </span>
        <span className="font-semibold text-[var(--fg-strong)]">{theme}</span>
        <span className="text-[var(--muted)]">
          {" "}
          — {line} ({emailIds.length})
        </span>
      </button>
      {open ? (
        <ul className="ml-5">
          {emailIds.map((id, n) => (
            <li key={id}>
              <button
                type="button"
                onClick={() => onOpen(id)}
                className="w-full truncate text-left text-[12px] leading-5 text-[var(--muted)] hover:text-[var(--fg)]"
              >
                · {lineFor(id) ?? `email ${n + 1}`}
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </li>
  );
}
