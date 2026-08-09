"use client";

import { Archive, CheckCircle2, ChevronDown, Trash2 } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { WaitingSection } from "@/components/inbox/WaitingSection";
import { TEACH_CHOICES, teachGroup } from "@/components/inbox/LogicExplain";
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
 *   Sender · Message (the AI's read leads when it adds signal, subject
 *   rides along) · Action (chip + picker + archive/delete, fixed-width
 *   so nothing bleeds into neighbors). The "why" lives on hover and in
 *   the reader. Zones (Needs you / FYI / Handled) survive as group rows.
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
  /** Correct the verdict: teaches the sender + applies to this email. */
  teach?: (
    fromEmail: string,
    action: TriageAction,
    messageId?: string,
    threadId?: string,
  ) => void;
  nudge: (messageId: string) => void;
  nudging: string | null;
  busyId: string | null;
};

/**
 * Rows whose suggestion Seer can execute for you (archive / delete /
 * unsubscribe). "Respond" and "your call" rows need the human — no
 * checkbox, confirming them means simply handling them.
 */
function confirmable(item: EmailItem): boolean {
  const a = item.guide?.action;
  return Boolean(
    a && a !== "respond" && a !== "act_today" && a !== "needs_review",
  );
}

/** Money mail, by every signal we have — category, rule, task text. */
function isMoney(item: EmailItem): boolean {
  const g = item.guide;
  if (!g) return false;
  const hay =
    `${g.category ?? ""} ${g.debug?.ruleId ?? ""} ${g.task ?? ""} ${item.subject}`.toLowerCase();
  return /money|bill|receipt|financ|invoice|payment|bank|payroll|autopay|auto.?pay|subscription|refund|charge|statement|deposit|wire|ach\b/.test(
    hay,
  );
}

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
      className="rounded px-2 py-0.5 text-[12px] text-white"
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
          className={`h-3.5 w-3.5 shrink-0 transition-transform ${open ?"" : "-rotate-90"}`}
          style={{ color }}
        />
        <span
          className="text-[12px] uppercase tracking-wide"
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

const CELL = "border-r border-[var(--border)] px-3 py-1.5 last:border-r-0";

/**
 * The AI's read earns screen space only when it says something the
 * subject doesn't ("Pay the $140 pool invoice" yes; a restated
 * "Exhibitor Confirmation" no).
 */
function meaningAddsSignal(meaning: string, subject: string): boolean {
  if (!meaning) return false;
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  const m = norm(meaning);
  const s = norm(subject);
  if (!m || m === s) return false;
  return !s.includes(m) && !m.includes(s);
}

/** One email as a table row (desktop) or a stacked block (mobile). */
function Row({
  item,
  h,
  mobile,
  emphasize,
  checked,
  onToggle,
  active,
}: {
  item: EmailItem;
  h: Handlers;
  mobile?: boolean;
  emphasize?: boolean;
  checked?: boolean;
  onToggle?: (range: boolean) => void;
  /** Keyboard cursor is on this row — spreadsheet style. */
  active?: boolean;
}) {
  const g = item.guide;
  const meaning = stripEmoji(g?.task ?? g?.instruction ?? "");
  const subject = stripEmoji(item.subject);
  const why = stripEmoji(g?.reason ?? "");
  const showMeaning = meaningAddsSignal(meaning, subject);

  if (mobile) {
    return (
      <div
        onClick={() => h.openReader(item.id)}
        className="cursor-pointer border-b border-[var(--border)] px-3 py-2"
      >
        <div className="flex items-baseline justify-between gap-2">
          <span
            className={`min-w-0 truncate text-[14px] ${emphasize ? "font-bold" : ""}`}
          >
            {senderLabel(item)}
          </span>
          <span className="shrink-0 text-[12px] text-[var(--muted)]">
            {formatMailTime(item.receivedAt)}
          </span>
        </div>
        {showMeaning ? (
          <div
            className="truncate text-[14px]"
            style={{ color: g?.color ?? "var(--fg)" }}
          >
            {meaning}
          </div>
        ) : null}
        <div className="flex items-center gap-2">
          <span className="min-w-0 flex-1 truncate text-[14px] text-[var(--muted)]">
            {subject}
          </span>
          <ActionChip item={item} h={h} />
          <RowActions item={item} h={h} />
        </div>
      </div>
    );
  }

  return (
    <tr
      ref={(el) => {
        if (active && el) el.scrollIntoView({ block: "nearest" });
      }}
      onClick={() => h.openReader(item.id)}
      className={`cursor-pointer border-b border-[var(--border)] align-middle ${ active ?"bg-[var(--brand-soft)]" : "hover:bg-[var(--card)]"
      }`}
    >
      <td
        className="border-r border-[var(--border)] px-2 py-1.5 text-center"
        onClick={(e) => e.stopPropagation()}
      >
        {onToggle ? (
          <input
            type="checkbox"
            checked={checked ?? false}
            onClick={(e) => {
              e.stopPropagation();
              onToggle(e.shiftKey);
            }}
            onChange={() => {}}
            aria-label="Confirm — do as suggested"
            className="h-3.5 w-3.5 accent-[var(--brand)]"
          />
        ) : null}
      </td>
      <td className={`max-w-0 truncate ${CELL}`}>
        <span className={`text-[14px] ${emphasize ? "font-bold" : ""}`}>
          {senderLabel(item)}
        </span>
        <span className="ml-1.5 text-[12px] text-[var(--muted)]">
          {formatMailTime(item.receivedAt)}
        </span>
      </td>
      {/* Message: the AI's read leads WHEN it adds signal; the subject
          rides along muted. Hover shows the full why. */}
      <td
        className={`max-w-0 truncate ${CELL} text-[14px]`}
        title={why ? `${meaning ? `${meaning} — ` : ""}${why}` : meaning}
      >
        {showMeaning ? (
          <>
            <span className="" style={{ color: g?.color ?? "var(--fg)" }}>
              {meaning}
            </span>
            <span className="ml-2 text-[14px] text-[var(--muted)]">
              {subject}
            </span>
          </>
        ) : (
          <span className="text-[var(--fg)]">{subject}</span>
        )}
      </td>
      <td className={`overflow-hidden ${CELL}`}>
        <span className="flex items-center gap-1 whitespace-nowrap">
          <ActionChip item={item} h={h} />
          {h.teach && g ? <CorrectPicker item={item} h={h} /> : null}
          <RowActions item={item} h={h} />
        </span>
      </td>
    </tr>
  );
}

/**
 * Airtable-style cell picker: change the verdict in place. Picking a
 * value teaches the sender and applies it to this email immediately.
 */
function CorrectPicker({ item, h }: { item: EmailItem; h: Handlers }) {
  const current = teachGroup(item.guide!.action);
  return (
    <span className="relative" onClick={(e) => e.stopPropagation()}>
      <select
        value=""
        onChange={(e) => {
          const a = e.target.value as TriageAction;
          if (a) h.teach?.(item.fromEmail, a, item.id, actionThreadId(item));
        }}
        aria-label="Change"
        title="Change"
        className="h-6 w-5 cursor-pointer appearance-none rounded-md border border-[var(--border)] bg-[var(--bg)] pl-1 text-[12px] text-[var(--muted)] hover:text-[var(--fg)]"
      >
        <option value="" hidden>
          ▾
        </option>
        {TEACH_CHOICES.filter((c) => c.action !== current).map((c) => (
          <option key={c.action} value={c.action}>
            {c.label}
          </option>
        ))}
      </select>
    </span>
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
    new Set(["money-act", "needs", "money-rec", "fyi", "done"]),
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
    const allNeeds: EmailItem[] = [
      ...triage.needsReview,
      ...NEEDS_YOU.flatMap((a) => byAction.get(a)?.items ?? []),
    ].sort(rankNeedsYou);

    // The user's categories, not the engine's: money that needs a hand
    // (invoices to pay, failed payments, checks) leads; money that's
    // just a record (receipts, statements, autopay) files together.
    const moneyAct = allNeeds.filter(isMoney);
    const needs = allNeeds.filter((i) => !isMoney(i));

    const allFyi = FYI.flatMap((a) => byAction.get(a)?.items ?? []);
    const handledAll = HANDLED.map((a) => byAction.get(a)).filter(
      (s): s is Section => Boolean(s && s.items.length > 0),
    );
    const moneyRecords = [
      ...allFyi.filter(isMoney),
      ...handledAll.flatMap((s) => s.items.filter(isMoney)),
    ];
    const fyi = allFyi.filter((i) => !isMoney(i));
    const handled = handledAll
      .map((s) => ({ ...s, items: s.items.filter((i) => !isMoney(i)) }))
      .filter((s) => s.items.length > 0);
    const handledCount = handled.reduce((n, s) => n + s.items.length, 0);
    return { moneyAct, needs, moneyRecords, fyi, handled, handledCount };
  }, [triage]);

  // ---- Spreadsheet plumbing: flat row order, cursor, range select ----
  const visibleRows = useMemo(() => {
    const rows: EmailItem[] = [];
    if (open.has("done")) for (const s of zones.handled) rows.push(...s.items);
    if (open.has("fyi")) rows.push(...zones.fyi);
    if (open.has("money-rec")) rows.push(...zones.moneyRecords);
    if (open.has("money-act")) rows.push(...zones.moneyAct);
    if (open.has("needs")) rows.push(...zones.needs);
    return rows;
  }, [zones, open]);
  const rowIdx = useMemo(
    () => new Map(visibleRows.map((r, i) => [r.id, i])),
    [visibleRows],
  );
  const [activeIdx, setActiveIdx] = useState(-1);
  useEffect(() => {
    if (activeIdx >= visibleRows.length) {
      setActiveIdx(visibleRows.length - 1);
    }
  }, [activeIdx, visibleRows.length]);

  // ---- Checkbox confirm: tick the rows Seer got right, run them all ----
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const anchorRef = useRef<number | null>(null);
  const togglePick = (id: string, range = false) => {
    const idx = rowIdx.get(id);
    setPicked((prev) => {
      const next = new Set(prev);
      // Shift-click: everything between the last tick and this one
      if (range && anchorRef.current != null && idx != null) {
        const lo = Math.min(anchorRef.current, idx);
        const hi = Math.max(anchorRef.current, idx);
        for (let i = lo; i <= hi; i++) {
          const r = visibleRows[i];
          if (r) next.add(r.id);
        }
        return next;
      }
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
    if (idx != null) anchorRef.current = idx;
  };

  const confirmables = useMemo(
    () =>
      [
        ...zones.needs,
        ...zones.fyi,
        ...zones.handled.flatMap((s) => s.items),
      ].filter(confirmable),
    [zones],
  );

  /**
   * YOUR choice beats the suggestion: explicit Archive/Delete applies
   * to every selected row exactly as stated — Delete means trash, it
   * NEVER silently unsubscribes.
   */
  const runPickedAs = (action: MailAction) => {
    const items = visibleRows.filter((i) => picked.has(i.id));
    if (items.length === 0) return;
    h.bulkSection(
      {
        action: action === "trash" ? "delete_now" : "read_and_archive",
        label: "Selected",
        color:
          action === "trash"
            ? ACTION_META.delete_now.color
            : ACTION_META.read_and_archive.color,
        bulkLabel: "",
        items,
      },
      action,
    );
    setPicked(new Set());
  };

  const runPicked = () => {
    const items = confirmables.filter((i) => picked.has(i.id));
    if (items.length === 0) return;
    // Group by what "correct" executes: real unsubscribe, trash, archive
    const unsub = items.filter((i) => i.guide?.action === "unsubscribe");
    const rest = items.filter((i) => i.guide?.action !== "unsubscribe");
    const toTrash = rest.filter(
      (i) => primaryMailAction(i.guide!.action) === "trash",
    );
    const toArchive = rest.filter(
      (i) => primaryMailAction(i.guide!.action) !== "trash",
    );
    if (unsub.length > 0) {
      h.bulkSection(
        {
          action: "unsubscribe",
          label: "Confirmed",
          color: ACTION_META.unsubscribe.color,
          bulkLabel: "",
          items: unsub,
        },
        "trash",
      );
    }
    if (toTrash.length > 0) {
      h.bulkSection(
        {
          action: "delete_now",
          label: "Confirmed",
          color: ACTION_META.delete_now.color,
          bulkLabel: "",
          items: toTrash,
        },
        "trash",
      );
    }
    if (toArchive.length > 0) {
      h.bulkSection(
        {
          action: "read_and_archive",
          label: "Confirmed",
          color: ACTION_META.read_and_archive.color,
          bulkLabel: "",
          items: toArchive,
        },
        "archive",
      );
    }
    setPicked(new Set());
  };

  // ---- Keyboard: work the table without the mouse (desktop only).
  // ↑↓/jk move · space/x tick · ⏎ open · e archive · d delete ·
  // a do-suggested · ⌘⏎ run ticked · esc clear ----
  const kb = useRef({ visibleRows, activeIdx, picked, togglePick, runPicked, h });
  kb.current = { visibleRows, activeIdx, picked, togglePick, runPicked, h };
  useEffect(() => {
    if (mobile) return;
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (
        t &&
        (t.tagName === "INPUT" ||
          t.tagName === "TEXTAREA" ||
          t.tagName === "SELECT" ||
          t.tagName === "BUTTON" ||
          t.isContentEditable)
      ) {
        return;
      }
      const { visibleRows: rows, activeIdx: idx, h: hh } = kb.current;
      if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
        e.preventDefault();
        kb.current.runPicked();
        return;
      }
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const item = idx >= 0 ? rows[idx] : undefined;
      switch (e.key) {
        case "ArrowDown":
        case "j":
          e.preventDefault();
          setActiveIdx((i) => Math.min(rows.length - 1, i + 1));
          break;
        case "ArrowUp":
        case "k":
          e.preventDefault();
          setActiveIdx((i) => Math.max(0, i < 0 ? 0 : i - 1));
          break;
        case " ":
        case "x":
          if (item) {
            e.preventDefault();
            kb.current.togglePick(item.id, e.shiftKey);
          }
          break;
        case "Enter":
          if (item) hh.openReader(item.id);
          break;
        case "e":
          if (item) {
            hh.runAction(item.id, "archive", item.fromEmail, actionThreadId(item));
          }
          break;
        case "d":
        case "#":
          if (item) {
            if (item.guide?.action === "unsubscribe") {
              hh.unsubscribe(item.id, item.fromEmail, actionThreadId(item));
            } else {
              hh.runAction(item.id, "trash", item.fromEmail, actionThreadId(item));
            }
          }
          break;
        case "a":
          if (item) doSuggested(item, hh);
          break;
        case "Escape":
          setPicked(new Set());
          setActiveIdx(-1);
          break;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [mobile]);

  const SPAN = 4;

  const groups: ReactNode[] = [];

  // 3. Handled for you — per-section sweeps
  if (zones.handled.length > 0) {
    groups.push(
      <GroupHeader
        key="h-done"
        label={`Clear · ${zones.handledCount}`}
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
                className="shrink-0 text-[14px] text-[var(--primary)]"
              >
                {section.bulkLabel}
              </button>
            }
          />,
        );
        for (const item of section.items) {
          groups.push(
            <Row
              key={item.id}
              item={item}
              h={h}
              mobile={mobile}
              checked={picked.has(item.id)}
              onToggle={(r) => togglePick(item.id, r)}
              active={!mobile && rowIdx.get(item.id) === activeIdx}
            />,
          );
        }
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
            className="shrink-0 text-[14px] text-[var(--primary)]"
          >
            Clear all
          </button>
        }
      />,
    );
    if (open.has("fyi")) {
      for (const item of zones.fyi) {
        groups.push(
          <Row
            key={item.id}
            item={item}
            h={h}
            mobile={mobile}
            checked={picked.has(item.id)}
            onToggle={(r) => togglePick(item.id, r)}
            active={!mobile && rowIdx.get(item.id) === activeIdx}
          />,
        );
      }
    }
  }

  // 1b. MONEY — RECORDS (receipts, statements, autopay bills, bank notices)
  if (zones.moneyRecords.length > 0) {
    groups.push(
      <GroupHeader
        key="h-money-rec"
        label={`Money — records · ${zones.moneyRecords.length} (receipts, statements, autopay)`}
        color="#0f766e"
        open={open.has("money-rec")}
        onToggle={() => toggle("money-rec")}
        span={SPAN}
        mobile={mobile}
        action={
          <button
            type="button"
            onClick={() =>
              h.bulkSection(
                {
                  action: "read_and_archive",
                  label: "Money records",
                  color: "#0f766e",
                  bulkLabel: "Archive all",
                  items: zones.moneyRecords,
                },
                "archive",
              )
            }
            className="shrink-0 text-[14px] text-[var(--primary)]"
          >
            Archive all
          </button>
        }
      />,
    );
    if (open.has("money-rec")) {
      for (const item of zones.moneyRecords) {
        groups.push(
          <Row
            key={item.id}
            item={item}
            h={h}
            mobile={mobile}
            checked={picked.has(item.id)}
            onToggle={(r) => togglePick(item.id, r)}
            active={!mobile && rowIdx.get(item.id) === activeIdx}
          />,
        );
      }
    }
  }

  // 0. MONEY — ACTION NEEDED (invoices to pay, failed payments, checks)
  if (zones.moneyAct.length > 0) {
    groups.push(
      <GroupHeader
        key="h-money-act"
        label={`Money — action needed · ${zones.moneyAct.length} (invoices to pay, payments, checks)`}
        color="#b45309"
        open={open.has("money-act")}
        onToggle={() => toggle("money-act")}
        span={SPAN}
        mobile={mobile}
      />,
    );
    if (open.has("money-act")) {
      for (const item of zones.moneyAct) {
        groups.push(
          <Row
            key={item.id}
            item={item}
            h={h}
            mobile={mobile}
            emphasize
            checked={picked.has(item.id)}
            onToggle={(r) => togglePick(item.id, r)}
            active={!mobile && rowIdx.get(item.id) === activeIdx}
          />,
        );
      }
    }
  }

  // 1. Needs you
  groups.push(
    <GroupHeader
      key="h-needs"
      label={`Needs you · ${zones.needs.length} — also tracked in Atlas`}
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
            className="flex items-center gap-2 px-3 py-3 text-[14px] text-[var(--muted)]"
          >
            <CheckCircle2 className="h-4 w-4 text-[#0b8043]" /> Nothing needs
            you right now.
          </p>
        ) : (
          <tr key="needs-empty">
            <td colSpan={SPAN} className="px-3 py-3 text-[14px] text-[var(--muted)]">
              Nothing needs you right now.
            </td>
          </tr>
        ),
      );
    } else {
      for (const item of zones.needs) {
        groups.push(
          <Row
            key={item.id}
            item={item}
            h={h}
            mobile={mobile}
            emphasize
            checked={picked.has(item.id)}
            onToggle={(r) => togglePick(item.id, r)}
            active={!mobile && rowIdx.get(item.id) === activeIdx}
          />,
        );
      }
    }
  }

  const TH =
    "sticky top-0 z-10 border-r border-[var(--border)] bg-[var(--card)] px-3 py-2 shadow-[inset_0_-1px_0_var(--border)] last:border-r-0";

  return (
    <div>
      <p className="flex items-baseline gap-2 border-b border-[var(--border)] bg-[var(--card)] px-3 py-2.5 text-[14px]">
        <span className="text-[var(--fg-strong)]">
          {zones.handledCount + zones.fyi.length} to clear
        </span>
        <span className="text-[var(--muted)]">
          · {zones.moneyRecords.length} money records ·{" "}
          {zones.moneyAct.length + zones.needs.length} need you
          {zones.moneyAct.length > 0
            ? ` (${zones.moneyAct.length} money)`
            : ""}{" "}
          — the work itself lives in Atlas
        </span>
        {triage.assistant?.pending ? (
          <span className="animate-pulse text-[12px] text-[var(--primary)]">
            · AI reading {triage.assistant.pending} in background…
          </span>
        ) : null}
        {!mobile ? (
          <span className="ml-auto shrink-0 text-[12px] font-normal text-[var(--nav-muted)]">
            ↑↓ move · space tick · ⇧ range · ⏎ open · e archive · d delete ·
            a do suggested · ⌘⏎ run ticked
          </span>
        ) : null}
      </p>

      {mobile ? (
        <div>{groups}</div>
      ) : (
        <table className="w-full table-fixed border-collapse">
          <thead>
            <tr className="text-left text-[12px] uppercase tracking-wide text-[var(--muted)]">
              <th className={`w-9 ${TH} !px-2 text-center`}>
                <input
                  type="checkbox"
                  checked={
                    visibleRows.length > 0 &&
                    picked.size === visibleRows.length
                  }
                  onChange={() =>
                    setPicked(
                      picked.size === visibleRows.length
                        ? new Set()
                        : new Set(visibleRows.map((i) => i.id)),
                    )
                  }
                  aria-label="Select all"
                  className="h-3.5 w-3.5 accent-[var(--brand)]"
                />
              </th>
              <th className={`w-[22%] ${TH}`}>Sender</th>
              <th className={TH}>Message</th>
              <th className={`w-[220px] ${TH}`}>Action</th>
            </tr>
          </thead>
          <tbody>{groups}</tbody>
        </table>
      )}

      {!mobile && picked.size > 0 ? (
        <div className="sticky bottom-0 z-20 flex items-center gap-2 border-t border-[var(--border)] bg-[var(--brand-soft)] px-3 py-2 shadow-[0_-2px_8px_rgba(10,45,40,0.08)]">
          <span className="text-[14px] text-[var(--fg-strong)]">
            {picked.size} selected
          </span>
          <button
            type="button"
            onClick={() => runPickedAs("archive")}
            className="rounded-md bg-[#0b8043] px-2.5 py-1 text-[14px] text-white"
          >
            Archive
          </button>
          <button
            type="button"
            onClick={() => runPickedAs("trash")}
            title="Delete only — never unsubscribes"
            className="rounded-md bg-[#d63b2f] px-2.5 py-1 text-[14px] text-white"
          >
            Delete
          </button>
          {confirmables.some((i) => picked.has(i.id)) ? (
            <button
              type="button"
              onClick={runPicked}
              title="Runs each row's suggestion — unsubscribe rows DO unsubscribe"
              className="rounded-md border border-[var(--brand)] px-2.5 py-1 text-[14px] text-[var(--brand)]"
            >
              Do as suggested
            </button>
          ) : null}
          <button
            type="button"
            onClick={() => setPicked(new Set())}
            className="ml-auto text-[14px] text-[var(--muted)] hover:text-[var(--fg)]"
          >
            Clear
          </button>
        </div>
      ) : null}

      <WaitingSection nudge={h.nudge} nudging={h.nudging} />
    </div>
  );
}
