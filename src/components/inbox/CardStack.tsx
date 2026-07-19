"use client";

import {
  Archive,
  CheckCircle2,
  Layers,
  MailOpen,
  Reply,
  Trash2,
} from "lucide-react";
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type TouchEvent,
} from "react";
import {
  formatMailTime,
  mailInitial,
  type EmailItem,
  type MailAction,
} from "@/lib/inbox/types";

type Props = {
  items: EmailItem[];
  busyId: string | null;
  onOpen: (id: string) => void;
  onAction: (id: string, action: MailAction, fromEmail?: string) => void;
  onReply: (id: string) => void;
  onEmptyRefresh?: () => void;
};

/**
 * Legacy Seer-style card deck: one email per card, swipe to decide.
 * Swipe right → archive · swipe left → trash · tap → open.
 */
export function CardStack({
  items,
  busyId,
  onOpen,
  onAction,
  onReply,
  onEmptyRefresh,
}: Props) {
  const [index, setIndex] = useState(0);
  const [dragX, setDragX] = useState(0);
  const [dragging, setDragging] = useState(false);
  const startX = useRef<number | null>(null);

  useEffect(() => {
    setIndex((i) => Math.min(i, Math.max(0, items.length - 1)));
  }, [items.length]);

  const remaining = items.slice(index);
  const current = remaining[0];
  const behind = remaining.slice(1, 3);

  const progress = useMemo(() => {
    if (items.length === 0) return "0 left";
    return `${items.length - index} left`;
  }, [index, items.length]);

  const commit = (action: MailAction) => {
    if (!current || busyId === current.id) return;
    onAction(current.id, action, current.fromEmail);
    setDragX(0);
    setIndex((i) => i + 1);
  };

  const onTouchStart = (e: TouchEvent) => {
    startX.current = e.touches[0]?.clientX ?? null;
    setDragging(true);
  };
  const onTouchMove = (e: TouchEvent) => {
    if (startX.current == null) return;
    setDragX((e.touches[0]?.clientX ?? startX.current) - startX.current);
  };
  const onTouchEnd = () => {
    setDragging(false);
    if (dragX > 110) commit("archive");
    else if (dragX < -110) commit("trash");
    else setDragX(0);
    startX.current = null;
  };

  if (!current) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center px-8 py-16 text-center">
        <CheckCircle2 className="mb-3 h-14 w-14 text-[var(--primary)] opacity-80" />
        <h2 className="text-xl font-medium">Deck clear</h2>
        <p className="mt-2 max-w-xs text-sm text-[var(--muted)]">
          You’ve worked through the card stack. Pull to refresh or check Mail
          for anything new.
        </p>
        {onEmptyRefresh ? (
          <button
            type="button"
            onClick={onEmptyRefresh}
            className="mt-6 rounded-md bg-[var(--accent)] px-5 py-2.5 text-sm font-medium text-[#333]"
          >
            Refresh cards
          </button>
        ) : null}
      </div>
    );
  }

  const rotate = dragX / 28;
  const archiveHint = dragX > 40;
  const trashHint = dragX < -40;

  return (
    <div className="flex flex-1 flex-col px-4 pb-2 pt-2">
      <div className="mb-3 flex items-center justify-between rounded-md bg-[var(--primary-soft)] px-3 py-2">
        <div className="flex items-center gap-2 text-sm font-semibold text-[var(--fg-strong)]">
          <Layers className="h-4 w-4 text-[var(--primary)]" />
          <span>Cards</span>
        </div>
        <span className="text-xs font-medium text-[var(--primary)]">
          {progress}
        </span>
      </div>

      <div className="relative mx-auto w-full max-w-md flex-1" style={{ minHeight: 420 }}>
        {behind
          .slice()
          .reverse()
          .map((item, i, arr) => {
            const depth = arr.length - i;
            return (
              <div
                key={item.id}
                className="seer-card absolute inset-x-0 top-0"
                style={{
                  transform: `translateY(${depth * 10}px) scale(${1 - depth * 0.04})`,
                  opacity: 1 - depth * 0.15,
                  zIndex: 10 - depth,
                }}
                aria-hidden
              >
                <CardFace item={item} muted />
              </div>
            );
          })}

        <div
          className="seer-card absolute inset-x-0 top-0 z-20 touch-pan-y"
          style={{
            transform: `translateX(${dragX}px) rotate(${rotate}deg)`,
            transition: dragging ? "none" : "transform 0.2s ease-out",
          }}
          onTouchStart={onTouchStart}
          onTouchMove={onTouchMove}
          onTouchEnd={onTouchEnd}
        >
          {archiveHint ? (
            <div className="pointer-events-none absolute left-4 top-6 z-30 rounded-lg bg-[#0b8043] px-3 py-1 text-xs font-bold uppercase tracking-wide text-white">
              Archive
            </div>
          ) : null}
          {trashHint ? (
            <div className="pointer-events-none absolute right-4 top-6 z-30 rounded-lg bg-[#d93025] px-3 py-1 text-xs font-bold uppercase tracking-wide text-white">
              Delete
            </div>
          ) : null}
          <CardFace
            item={current}
            onTap={() => {
              if (Math.abs(dragX) < 8) onOpen(current.id);
            }}
          />
        </div>
      </div>

      <div className="mx-auto mt-4 flex w-full max-w-md items-center justify-around gap-2 pb-2">
        <CardAction
          label="Delete"
          color="#d93025"
          disabled={busyId === current.id}
          onClick={() => commit("trash")}
        >
          <Trash2 className="h-5 w-5" />
        </CardAction>
        <CardAction
          label="Open"
          color="var(--muted)"
          onClick={() => onOpen(current.id)}
        >
          <MailOpen className="h-5 w-5" />
        </CardAction>
        <CardAction
          label="Reply"
          color="var(--primary)"
          onClick={() => onReply(current.id)}
        >
          <Reply className="h-5 w-5" />
        </CardAction>
        <CardAction
          label="Archive"
          color="#0b8043"
          disabled={busyId === current.id}
          onClick={() => commit("archive")}
        >
          <Archive className="h-5 w-5" />
        </CardAction>
      </div>
      <p className="pb-2 text-center text-[11px] text-[var(--muted)]">
        Swipe right to archive · left to delete
      </p>
    </div>
  );
}

function CardFace({
  item,
  muted,
  onTap,
}: {
  item: EmailItem;
  muted?: boolean;
  onTap?: () => void;
}) {
  const g = item.guide;
  const accent = g?.color ?? "#3498d9";
  return (
    <article
      role={onTap ? "button" : undefined}
      tabIndex={onTap ? 0 : undefined}
      onClick={onTap}
      onKeyDown={
        onTap
          ? (e) => {
              if (e.key === "Enter") onTap();
            }
          : undefined
      }
      className={`flex min-h-[380px] flex-col rounded-2xl border border-[var(--border)] bg-[var(--bg)] p-5 shadow-[0_8px_28px_rgba(0,0,0,0.12)] dark:shadow-[0_8px_28px_rgba(0,0,0,0.45)] ${
        muted ? "pointer-events-none" : ""
      }`}
    >
      <div className="flex items-start gap-3">
        <div
          className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full text-base font-semibold text-white"
          style={{ backgroundColor: accent }}
        >
          {mailInitial(item.fromName || item.fromEmail)}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline justify-between gap-2">
            <h3 className="truncate text-[17px] font-semibold">
              {item.fromName || item.fromEmail}
            </h3>
            <time className="shrink-0 text-xs text-[var(--muted)]">
              {formatMailTime(item.receivedAt)}
            </time>
          </div>
          <p className="truncate text-xs text-[var(--muted)]">
            {item.fromEmail}
          </p>
        </div>
      </div>

      <h2 className="mt-4 text-[18px] font-medium leading-snug">
        {item.subject}
      </h2>
      <p className="mt-2 line-clamp-6 flex-1 text-[14px] leading-relaxed text-[var(--muted)]">
        {item.snippet || "No preview"}
      </p>

      {g ? (
        <div
          className="mt-4 rounded-xl px-3 py-3"
          style={{ backgroundColor: `${g.color}18` }}
        >
          <div
            className="text-xs font-semibold uppercase tracking-wide"
            style={{ color: g.color }}
          >
            {g.label}
            {g.confidence ? ` · ${g.confidence}` : ""}
          </div>
          <div className="mt-1 text-[13px] text-[var(--fg)]">{g.reason}</div>
          {g.who ? (
            <div className="mt-2 text-[12px] leading-snug text-[var(--fg)]">
              <span className="font-semibold">Who:</span> {g.who}
            </div>
          ) : null}
          {g.harm ? (
            <div className="mt-1 text-[12px] leading-snug text-[var(--muted)]">
              <span className="font-semibold">If deleted:</span> {g.harm}
            </div>
          ) : null}
          {g.debug ? (
            <div className="mt-2 font-mono text-[10px] text-[var(--muted)]">
              {g.debug.ruleId} · {g.debug.relationship} · sent×
              {g.debug.sentTo}
            </div>
          ) : null}
          <div className="mt-1 text-sm font-medium" style={{ color: g.color }}>
            {g.instruction}
          </div>
        </div>
      ) : (
        <div className="mt-4 rounded-xl bg-[var(--card)] px-3 py-3 text-sm text-[var(--muted)]">
          Decide what to do with this message
        </div>
      )}
    </article>
  );
}

function CardAction({
  children,
  label,
  color,
  onClick,
  disabled,
}: {
  children: React.ReactNode;
  label: string;
  color: string;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className="flex flex-col items-center gap-1 disabled:opacity-40"
    >
      <span
        className="flex h-14 w-14 items-center justify-center rounded-full border border-[var(--border)] bg-[var(--bg)] shadow-sm"
        style={{ color }}
      >
        {children}
      </span>
      <span className="text-[10px] text-[var(--muted)]">{label}</span>
    </button>
  );
}
