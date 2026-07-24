"use client";

import { Archive, CheckCircle2, ChevronDown, Trash2 } from "lucide-react";
import { useMemo, useState, type ReactNode } from "react";
import { WaitingSection } from "@/components/inbox/WaitingSection";
import { ACTION_META, type TriageAction } from "@/lib/inbox/classify";
import {
  actionThreadId,
  formatMailTime,
  primaryMailAction,
  stripEmoji,
  type EmailItem,
  type MailAction,
  type Section,
  type TodayData,
} from "@/lib/inbox/types";

/**
 * TRIAGE AS A TABLE — scannable in one pass, no emoji, no prose walls:
 *   Sender · Subject · Meaning (the AI's read) · Suggested action · Why
 * Desktop renders a real table; mobile stacks the same fields in the
 * same order. Zones (Needs you / FYI / Handled) survive as group rows.
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
  nudge: (messageId: string) => void;
  nudging: string | null;
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

function senderLabel(item: EmailItem): string {
  const raw = item.threadSenders?.length
    ? item.threadSenders.join(", ")
    : item.fromName || item.fromEmail;
  return (
    stripEmoji(raw) + ((item.threadCount ?? 1) > 1 ? ` · ${item.threadCount}` : "")
  );
}

/** The suggested action, executed: open for respond/act, real unsub, etc. */
function doSuggested(item: EmailItem, h: Handlers) {
  const a = item.guide?.action;
  if (!a || a === "respond" || a === "act_today" || a === "needs_review") {
    h.openReader(item.id);
    return;
  }
  if (a === "unsubscribe") {
    h.unsubscribe(item.id, item.fromEmail, actionThreadId(item));
    return;
  }
  h.runAction(item.id, primaryMailAction(a), item.fromEmail, actionThreadId(item));
}

function RowActions({ item, h }: { item: EmailItem; h: Handlers }) {
  const busy = h.busyId === item.id;
  return (
    <span className="flex shrink-0 items-center gap-1">
      <button
        type="button"
        disabled={busy}
        aria-label="Archive"
        onClick={(e) => {
          e.stopPropagation();
          h.runAction(item.id, "archive", item.fromEmail, actionThreadId(item));
        }}
        className="rounded-md border border-[var(--border)] p-1.5 text-[#0b8043] disabled:opacity-40"
      >
        <Archive className="h-3.5 w-3.5" />
      </button>
      <button
        type="button"
        disabled={busy}
        aria-label="Delete"
        onClick={(e) => {
          e.stopPropagation();
          if (item.guide?.action === "unsubscribe") {
            h.unsubscribe(item.id, item.fromEmail, actionThreadId(item));
          } else {
            h.runAction(item.id, "trash", item.fromEmail, actionThreadId(item));
          }
        }}
        className="rounded-md border border-[var(--border)] p-1.5 text-[#d63b2f] disabled:opacity-40"
      >
        <Trash2 className="h-3.5 w-3.5" />
      </button>
    </span>
  );
}

function ActionChip({ item, h }: { item: EmailItem; h: Handlers }) {
  const a = item.guide?.action;
  if (!a) return null;
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        doSuggested(item, h);
      }}
      className="rounded px-2 py-0.5 text-[11px] font-bold text-white"
      style={{ backgroundColor: ACTION_META[a].color }}
      title="Do the suggested action"
    >
      {ACTION_META[a].short}
    </button>
  );
}

function GroupHeader({
  label,
  color,
  open,
  onToggle,
  action,
  span,
  mobile,
}: {
  label: string;
  color: string;
  open: boolean;
  onToggle: () => void;
  action?: ReactNode;
  span: number;
  mobile?: boolean;
}) {
  const inner = (
    <div className="flex w-full items-center gap-2 px-3 py-2">
      <button
        type="button"
        onClick={onToggle}
        className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
      >
        <ChevronDown
          className={`h-3.5 w-3.5 shrink-0 transition-transform ${open ? "" : "-rotate-90"}`}
          style={{ color }}
        />
        <span
          className="text-[11px] font-bold uppercase tracking-wide"
          style={{ color }}
        >
          {label}
        </span>
      </button>
      {action}
    </div>
  );
  if (mobile) return <div className="bg-[var(--card)]">{inner}</div>;
  return (
    <tr className="bg-[var(--card)]">
      <td colSpan={span} className="p-0">
        {inner}
      </td>
    </tr>
  );
}

/** One email as a table row (desktop) or a stacked block (mobile). */
function Row({
  item,
  h,
  mobile,
  emphasize,
}: {
  item: EmailItem;
  h: Handlers;
  mobile?: boolean;
  emphasize?: boolean;
}) {
  const g = item.guide;
  const meaning = stripEmoji(g?.task ?? g?.instruction ?? "");
  const subject = stripEmoji(item.subject);
  const why = stripEmoji(g?.reason ?? "");

  if (mobile) {
    return (
      <div
        onClick={() => h.openReader(item.id)}
        className="cursor-pointer border-b border-[var(--border)] px-3 py-2"
      >
        <div className="flex items-baseline justify-between gap-2">
          <span
            className={`min-w-0 truncate text-[13px] ${emphasize ? "font-bold" : "font-semibold"}`}
          >
            {senderLabel(item)}
          </span>
          <span className="shrink-0 text-[11px] text-[var(--muted)]">
            {formatMailTime(item.receivedAt)}
          </span>
        </div>
        <div className="truncate text-[12px] text-[var(--muted)]">{subject}</div>
        {meaning ? (
          <div
            className="truncate text-[13px] font-medium"
            style={{ color: g?.color ?? "var(--fg)" }}
          >
            {meaning}
          </div>
        ) : null}
        <div className="mt-1 flex items-center gap-2">
          <ActionChip item={item} h={h} />
          <span className="min-w-0 flex-1 truncate text-[11px] text-[var(--muted)]">
            {why}
          </span>
          <RowActions item={item} h={h} />
        </div>
      </div>
    );
  }

  return (
    <tr
      onClick={() => h.openReader(item.id)}
      className="cursor-pointer border-b border-[var(--border)] align-top hover:bg-[var(--card)]"
    >
      <td className="max-w-0 truncate px-3 py-2">
        <span className={`text-[13px] ${emphasize ? "font-bold" : "font-semibold"}`}>
          {senderLabel(item)}
        </span>
        <div className="text-[11px] text-[var(--muted)]">
          {formatMailTime(item.receivedAt)}
        </div>
      </td>
      <td
        className="max-w-0 truncate px-3 py-2 text-[13px] text-[var(--fg)]"
        title={subject}
      >
        {subject}
      </td>
      <td
        className="max-w-0 truncate px-3 py-2 text-[13px] font-medium"
        style={{ color: g?.color ?? "var(--fg)" }}
        title={meaning}
      >
        {meaning}
        {g?.category ? (
          <span className="ml-1.5 rounded bg-[var(--card)] px-1 py-0.5 text-[10px] font-semibold text-[var(--muted)]">
            {stripEmoji(g.category)}
          </span>
        ) : null}
      </td>
      <td className="whitespace-nowrap px-3 py-2">
        <span className="flex items-center gap-1.5">
          <ActionChip item={item} h={h} />
          <RowActions item={item} h={h} />
        </span>
      </td>
      <td
        className="max-w-0 truncate px-3 py-2 text-[12px] text-[var(--muted)]"
        title={why}
      >
        {why}
      </td>
    </tr>
  );
}

export function TriageTable({
  triage,
  h,
  mobile,
}: {
  triage: TodayData;
  h: Handlers;
  mobile?: boolean;
}) {
  const [open, setOpen] = useState<Set<string>>(
    new Set(["needs", "fyi", "done"]),
  );
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

  const SPAN = 5;

  const groups: ReactNode[] = [];

  // 1. Needs you
  groups.push(
    <GroupHeader
      key="h-needs"
      label={`Needs you · ${zones.needs.length}`}
      color="#d97706"
      open={open.has("needs")}
      onToggle={() => toggle("needs")}
      span={SPAN}
      mobile={mobile}
    />,
  );
  if (open.has("needs")) {
    if (zones.needs.length === 0) {
      groups.push(
        mobile ? (
          <p
            key="needs-empty"
            className="flex items-center gap-2 px-3 py-3 text-[13px] text-[var(--muted)]"
          >
            <CheckCircle2 className="h-4 w-4 text-[#0b8043]" /> Nothing needs
            you right now.
          </p>
        ) : (
          <tr key="needs-empty">
            <td colSpan={SPAN} className="px-3 py-3 text-[13px] text-[var(--muted)]">
              Nothing needs you right now.
            </td>
          </tr>
        ),
      );
    } else {
      for (const item of zones.needs) {
        groups.push(<Row key={item.id} item={item} h={h} mobile={mobile} emphasize />);
      }
    }
  }

  // 2. FYI
  if (zones.fyi.length > 0) {
    groups.push(
      <GroupHeader
        key="h-fyi"
        label={`FYI — skim once · ${zones.fyi.length}`}
        color="#0e7490"
        open={open.has("fyi")}
        onToggle={() => toggle("fyi")}
        span={SPAN}
        mobile={mobile}
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
      />,
    );
    if (open.has("fyi")) {
      for (const item of zones.fyi) {
        groups.push(<Row key={item.id} item={item} h={h} mobile={mobile} />);
      }
    }
  }

  // 3. Handled for you — per-section sweeps
  if (zones.handled.length > 0) {
    groups.push(
      <GroupHeader
        key="h-done"
        label={`Handled for you · ${zones.handledCount}`}
        color="#64748b"
        open={open.has("done")}
        onToggle={() => toggle("done")}
        span={SPAN}
        mobile={mobile}
      />,
    );
    if (open.has("done")) {
      for (const section of zones.handled) {
        groups.push(
          <GroupHeader
            key={`h-${section.action}`}
            label={`${section.label} · ${section.items.length}`}
            color={section.color}
            open
            onToggle={() => {}}
            span={SPAN}
            mobile={mobile}
            action={
              <button
                type="button"
                onClick={() =>
                  h.bulkSection(section, primaryMailAction(section.action))
                }
                className="shrink-0 text-[12px] font-semibold text-[var(--primary)]"
              >
                {section.bulkLabel}
              </button>
            }
          />,
        );
        for (const item of section.items) {
          groups.push(<Row key={item.id} item={item} h={h} mobile={mobile} />);
        }
      }
    }
  }

  return (
    <div>
      <p className="border-b border-[var(--border)] bg-[var(--card)] px-3 py-2.5 text-[13px] font-medium">
        <span className="font-bold text-[var(--fg-strong)]">
          {zones.needs.length} need you
        </span>
        <span className="text-[var(--muted)]">
          {" "}
          · {zones.fyi.length} to skim · {zones.handledCount} handled for you
        </span>
      </p>

      {mobile ? (
        <div>{groups}</div>
      ) : (
        <table className="w-full table-fixed border-collapse">
          <thead>
            <tr className="border-b border-[var(--border)] text-left text-[10px] font-bold uppercase tracking-wide text-[var(--muted)]">
              <th className="w-[16%] px-3 py-2">Sender</th>
              <th className="w-[22%] px-3 py-2">Subject</th>
              <th className="w-[26%] px-3 py-2">Meaning</th>
              <th className="w-[13%] px-3 py-2">Action</th>
              <th className="w-[23%] px-3 py-2">Why</th>
            </tr>
          </thead>
          <tbody>{groups}</tbody>
        </table>
      )}

      <WaitingSection nudge={h.nudge} nudging={h.nudging} />
    </div>
  );
}
