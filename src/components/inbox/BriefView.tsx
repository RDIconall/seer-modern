"use client";

import {
  Archive,
  CheckCircle2,
  ChevronDown,
  Trash2,
} from "lucide-react";
import { useMemo, useState, type ReactNode } from "react";
import { LogicExplain } from "@/components/inbox/LogicExplain";
import { WaitingSection } from "@/components/inbox/WaitingSection";
import type { TriageAction } from "@/lib/inbox/classify";
import {
  actionThreadId,
  formatMailTime,
  primaryMailAction,
  type EmailItem,
  type MailAction,
  type Section,
  type TodayData,
} from "@/lib/inbox/types";

/**
 * THE BRIEF — the triage page structured the way a predictive EA would
 * speak it: one summary line, then five zones.
 *   1. Needs you (ranked by importance, people first)
 *   2. Waiting on (your sent mail met silence)
 *   3. FYI digest (one-line facts, clear in one tap)
 *   4. Handled for you (the receipt: filed / deleted / unsubscribed)
 * Every row can be corrected between archive and delete on the spot.
 */

const NEEDS_YOU: TriageAction[] = [
  "needs_review",
  "act_today",
  "respond",
  "review_subscription",
];
const FYI: TriageAction[] = ["read_and_delete"];
const HANDLED: TriageAction[] = [
  "read_and_archive",
  "delete_now",
  "unsubscribe",
  "glance_promo",
];

type Handlers = {
  openReader: (id: string) => void;
  runAction: (
    id: string,
    action: MailAction,
    fromEmail?: string,
    threadId?: string,
  ) => void;
  bulkSection: (section: Section, action: MailAction) => void;
  unsubscribe: (id: string, fromEmail?: string, threadId?: string) => void;
  teachSender: (
    fromEmail: string,
    action: TriageAction,
    id?: string,
    threadId?: string,
  ) => void;
  nudge: (messageId: string) => void;
  nudging: string | null;
  logicMode: boolean;
  busyId: string | null;
};

function rankNeedsYou(a: EmailItem, b: EmailItem): number {
  const imp = (x: EmailItem) => x.guide?.importance ?? 1.5;
  if (imp(b) !== imp(a)) return imp(b) - imp(a);
  const order = (x: EmailItem) =>
    NEEDS_YOU.indexOf(x.guide?.action ?? "needs_review");
  if (order(a) !== order(b)) return order(a) - order(b);
  return a.receivedAt < b.receivedAt ? 1 : -1;
}

export function BriefView({
  triage,
  h,
}: {
  triage: TodayData;
  h: Handlers;
}) {
  const [open, setOpen] = useState<Set<string>>(new Set(["needs"]));
  const toggle = (k: string) =>
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(k)) next.delete(k);
      else next.add(k);
      return next;
    });

  const zones = useMemo(() => {
    const byAction = new Map<TriageAction, Section>();
    for (const s of triage.sections) byAction.set(s.action, s);

    const needs: EmailItem[] = [
      ...triage.needsReview,
      ...NEEDS_YOU.flatMap((a) => byAction.get(a)?.items ?? []),
    ].sort(rankNeedsYou);

    const fyi = FYI.flatMap((a) => byAction.get(a)?.items ?? []);
    const handled = HANDLED.map((a) => byAction.get(a)).filter(
      (s): s is Section => Boolean(s && s.items.length > 0),
    );
    const handledCount = handled.reduce((n, s) => n + s.items.length, 0);
    return { needs, fyi, handled, handledCount };
  }, [triage]);

  return (
    <div>
      {/* 0. The brief line */}
      <p className="border-b border-[var(--border)] bg-[var(--card)] px-4 py-2.5 text-[13px] font-medium">
        <span className="font-bold text-[var(--fg-strong)]">
          {zones.needs.length} need you
        </span>
        <span className="text-[var(--muted)]">
          {" "}
          · {zones.fyi.length} to skim · {zones.handledCount} handled for you
        </span>
      </p>

      {/* 1. NEEDS YOU */}
      <ZoneHeader
        label={`Needs you · ${zones.needs.length}`}
        color="#d97706"
        open={open.has("needs")}
        onToggle={() => toggle("needs")}
      />
      {open.has("needs") ? (
        zones.needs.length === 0 ? (
          <p className="flex items-center gap-2 px-4 py-4 text-[13px] text-[var(--muted)]">
            <CheckCircle2 className="h-4 w-4 text-[#0b8043]" />
            Nothing needs you right now.
          </p>
        ) : (
          <ul>
            {zones.needs.map((item) => (
              <BriefRow
                key={item.id}
                item={item}
                h={h}
                emphasize
              />
            ))}
          </ul>
        )
      ) : null}

      {/* 2. WAITING ON */}
      <WaitingSection nudge={h.nudge} nudging={h.nudging} />

      {/* 3. FYI DIGEST */}
      {zones.fyi.length > 0 ? (
        <>
          <ZoneHeader
            label={`FYI — skim once · ${zones.fyi.length}`}
            color="#0e7490"
            open={open.has("fyi")}
            onToggle={() => toggle("fyi")}
            action={
              <button
                type="button"
                onClick={() =>
                  h.bulkSection(
                    {
                      action: "read_and_delete",
                      label: "FYI",
                      color: "#0e7490",
                      bulkLabel: "Clear all",
                      items: zones.fyi,
                    },
                    "trash",
                  )
                }
                className="shrink-0 text-[12px] font-semibold text-[var(--primary)]"
              >
                Clear all
              </button>
            }
          />
          {open.has("fyi") ? (
            <ul>
              {zones.fyi.map((item) => (
                <BriefRow key={item.id} item={item} h={h} />
              ))}
            </ul>
          ) : null}
        </>
      ) : null}

      {/* 4. HANDLED FOR YOU — the receipt */}
      {zones.handled.length > 0 ? (
        <>
          <ZoneHeader
            label={`Handled for you · ${zones.handledCount}`}
            color="#64748b"
            open={open.has("done")}
            onToggle={() => toggle("done")}
            sub={zones.handled
              .map((s) => `${s.items.length} ${verbFor(s.action)}`)
              .join(" · ")}
          />
          {open.has("done")
            ? zones.handled.map((section) => (
                <div key={section.action}>
                  <div className="flex items-center justify-between bg-[var(--card)] px-4 py-1.5">
                    <span
                      className="text-[11px] font-bold uppercase tracking-wide"
                      style={{ color: section.color }}
                    >
                      {section.label} · {section.items.length}
                    </span>
                    <button
                      type="button"
                      onClick={() =>
                        h.bulkSection(
                          section,
                          primaryMailAction(section.action),
                        )
                      }
                      className="text-[12px] font-semibold text-[var(--primary)]"
                    >
                      {section.bulkLabel}
                    </button>
                  </div>
                  <ul>
                    {section.items.map((item) => (
                      <BriefRow key={item.id} item={item} h={h} />
                    ))}
                  </ul>
                </div>
              ))
            : null}
        </>
      ) : null}
    </div>
  );
}

function verbFor(a: TriageAction): string {
  if (a === "read_and_archive") return "filed";
  if (a === "unsubscribe") return "unsubscribed";
  return "deleted";
}

function ZoneHeader({
  label,
  sub,
  color,
  open,
  onToggle,
  action,
}: {
  label: string;
  sub?: string;
  color: string;
  open: boolean;
  onToggle: () => void;
  action?: ReactNode;
}) {
  return (
    <div className="sticky top-0 z-[1] flex items-center justify-between gap-2 border-b border-[var(--border)] bg-[var(--brand-soft)] px-4 py-2.5">
      <button
        type="button"
        onClick={onToggle}
        className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
      >
        <span
          className="h-2 w-2 shrink-0 rounded-full"
          style={{ backgroundColor: color }}
          aria-hidden
        />
        <span className="truncate text-[13px] font-bold" style={{ color }}>
          {label}
        </span>
        {sub ? (
          <span className="truncate text-[11px] text-[var(--muted)]">
            {sub}
          </span>
        ) : null}
        <ChevronDown
          className={`h-4 w-4 shrink-0 opacity-60 transition-transform ${open ? "" : "-rotate-90"}`}
        />
      </button>
      {action}
    </div>
  );
}

/**
 * One decision per row: task headline, sender, and the archive↔delete
 * correction pair — whichever Seer did NOT recommend is one tap away.
 */
function BriefRow({
  item,
  h,
  emphasize,
}: {
  item: EmailItem;
  h: Handlers;
  emphasize?: boolean;
}) {
  const g = item.guide;
  const busy = h.busyId === item.id;
  return (
    <li
      className={`border-b border-[var(--border)] ${busy ? "opacity-50" : ""}`}
    >
      <div className="flex items-center gap-2 px-4 py-2">
        <button
          type="button"
          onClick={() => h.openReader(item.id)}
          className="min-w-0 flex-1 text-left"
        >
          <span className="flex items-baseline justify-between gap-2">
            <span
              className={`truncate ${emphasize ? "text-[14px] font-bold" : "text-[13px] font-semibold"}`}
              style={{ color: g?.color ?? "var(--fg-strong)" }}
            >
              {g?.task ?? item.subject}
            </span>
            <span className="shrink-0 text-[11px] text-[var(--muted)]">
              {formatMailTime(item.receivedAt)}
            </span>
          </span>
          <span className="flex items-baseline gap-1.5 truncate text-[12px] text-[var(--muted)]">
            <span className="truncate font-medium text-[var(--fg)]">
              {item.fromName || item.fromEmail}
              {(item.threadCount ?? 1) > 1 ? (
                <span className="font-normal text-[var(--muted)]">
                  {" "}
                  · {item.threadCount}
                </span>
              ) : null}
            </span>
            {g?.category ? (
              <span className="shrink-0 rounded bg-[var(--card)] px-1 text-[10px] font-semibold">
                {g.category}
              </span>
            ) : null}
            <span className="truncate">{item.subject}</span>
          </span>
          {h.logicMode && g ? (
            <LogicExplain
              guide={g}
              expanded
              onTeach={(a) => h.teachSender(item.fromEmail, a, item.id, item.threadId)}
            />
          ) : null}
        </button>
        {/* Correct between archive and delete — always both, one tap */}
        <button
          type="button"
          disabled={busy}
          aria-label="Archive it"
          onClick={() =>
            h.runAction(item.id, "archive", item.fromEmail, actionThreadId(item))
          }
          className="shrink-0 rounded-full border border-[var(--border)] p-2 text-[#0b8043] disabled:opacity-40"
        >
          <Archive className="h-4 w-4" />
        </button>
        <button
          type="button"
          disabled={busy}
          aria-label="Delete it"
          onClick={() =>
            g?.action === "unsubscribe"
              ? h.unsubscribe(item.id, item.fromEmail, actionThreadId(item))
              : h.runAction(item.id, "trash", item.fromEmail, actionThreadId(item))
          }
          className="shrink-0 rounded-full border border-[var(--border)] p-2 text-[#d63b2f] disabled:opacity-40"
        >
          <Trash2 className="h-4 w-4" />
        </button>
      </div>
    </li>
  );
}
