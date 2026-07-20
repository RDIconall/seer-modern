"use client";

import {
  AlarmClock,
  Archive,
  CheckCircle2,
  Layers,
  MailOpen,
  Reply,
  Trash2,
  UserRoundPlus,
  Zap,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type TouchEvent,
} from "react";
import {
  formatMailTime,
  mailInitial,
  primaryMailAction,
  type DeckCard,
  type EmailItem,
  type MailAction,
  type Section,
} from "@/lib/inbox/types";

type Props = {
  deck: DeckCard[];
  busyId: string | null;
  onOpen: (id: string) => void;
  onAction: (id: string, action: MailAction, fromEmail?: string) => void;
  onBulk: (section: Section, action: MailAction) => void;
  onReply: (id: string) => void;
  /** Skip for now — card leaves the deck locally, returns next refresh. */
  onSnooze?: (id: string) => void;
  /** Forward to the EA. Resolves true when it actually went out. */
  onDelegate?: (id: string) => Promise<boolean>;
  onEmptyRefresh?: () => void;
};

/**
 * Legacy Seer-style card deck: one email per card, swipe to decide.
 * Swipe right → archive · swipe left → trash · tap → open.
 *
 * Cards advance by dismissing ids (not an index): when an action
 * optimistically removes the email from the triage list, the deck
 * shrinks by exactly that card — nothing gets skipped, nothing lags.
 * Whole-section "delete all of these" cards ride in the same deck.
 */
export function CardStack({
  deck,
  busyId,
  onOpen,
  onAction,
  onBulk,
  onReply,
  onSnooze,
  onDelegate,
  onEmptyRefresh,
}: Props) {
  // Locally skipped cards (e.g. "decide one by one" on a bulk card).
  // Acted-on cards leave the deck via the parent's optimistic update.
  const [skipped, setSkipped] = useState<ReadonlySet<string>>(new Set());
  const [dragX, setDragX] = useState(0);
  const [dragging, setDragging] = useState(false);
  const startX = useRef<number | null>(null);

  const visible = useMemo(
    () => deck.filter((c) => !skipped.has(c.key)),
    [deck, skipped],
  );
  const current = visible[0];
  const behind = visible.slice(1, 3);

  const skip = (key: string) => {
    setSkipped((prev) => new Set(prev).add(key));
    setDragX(0);
  };

  const commit = (card: DeckCard, action: MailAction) => {
    setDragX(0);
    if (card.kind === "email") {
      if (busyId === card.item.id) return;
      // The optimistic removal in onAction pulls this card out of the
      // deck; also mark skipped so the UI advances even if it lingers.
      onAction(card.item.id, action, card.item.fromEmail);
    } else {
      onBulk(card.section, action);
    }
    setSkipped((prev) => new Set(prev).add(card.key));
  };

  /** One tap on what Seer recommends for this exact email. */
  const doSuggested = (item: EmailItem, card: DeckCard) => {
    const g = item.guide;
    if (!g) return;
    if (g.action === "respond") {
      onReply(item.id);
      return;
    }
    if (g.action === "act_today" || g.action === "needs_review") {
      onOpen(item.id);
      return;
    }
    commit(card, primaryMailAction(g.action));
  };

  /** Skip this card without acting — it returns on the next refresh. */
  const snoozeCard = (card: DeckCard) => {
    setSkipped((prev) => new Set(prev).add(card.key));
    setDragX(0);
    if (card.kind === "email") onSnooze?.(card.item.id);
  };

  const delegateCard = async (card: DeckCard) => {
    if (card.kind !== "email" || !onDelegate) return;
    const ok = await onDelegate(card.item.id);
    if (ok) {
      setSkipped((prev) => new Set(prev).add(card.key));
      setDragX(0);
    }
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
    if (current?.kind === "email") {
      if (dragX > 110) {
        commit(current, "archive");
        startX.current = null;
        return;
      }
      if (dragX < -110) {
        commit(current, "trash");
        startX.current = null;
        return;
      }
    }
    setDragX(0);
    startX.current = null;
  };

  // ---- Trackpad swipe: two-finger horizontal scrolls arrive as wheel
  // events with deltaX. Native non-passive listener so preventDefault
  // stops the browser's own back/forward swipe navigation. ----
  const cardEl = useRef<HTMLDivElement | null>(null);
  const wheelX = useRef(0);
  const wheelEndTimer = useRef<number | null>(null);
  const wheelLocked = useRef(false);
  const currentRef = useRef<DeckCard | undefined>(current);
  currentRef.current = current;
  const commitRef = useRef(commit);
  commitRef.current = commit;

  const endWheelGesture = useCallback(() => {
    const dx = wheelX.current;
    const alreadyCommitted = wheelLocked.current;
    wheelX.current = 0;
    wheelLocked.current = false;
    setDragging(false);
    const card = currentRef.current;
    if (!alreadyCommitted && card?.kind === "email") {
      if (dx > 110) {
        commitRef.current(card, "archive");
        return;
      }
      if (dx < -110) {
        commitRef.current(card, "trash");
        return;
      }
    }
    setDragX(0);
  }, []);

  useEffect(() => {
    const el = cardEl.current;
    if (!el) return;
    const onWheel = (e: globalThis.WheelEvent) => {
      // Vertical scrolls pass through; horizontal ones drag the card
      if (Math.abs(e.deltaX) <= Math.abs(e.deltaY) && wheelX.current === 0) {
        return;
      }
      e.preventDefault();
      if (wheelEndTimer.current) window.clearTimeout(wheelEndTimer.current);
      wheelEndTimer.current = window.setTimeout(endWheelGesture, 140);
      if (wheelLocked.current) return; // swallow trackpad inertia after commit
      wheelX.current += -e.deltaX;
      setDragging(true);
      setDragX(wheelX.current);
      // Swiped far enough — act now instead of waiting for fingers to lift
      const card = currentRef.current;
      if (card?.kind === "email" && Math.abs(wheelX.current) > 160) {
        const dx = wheelX.current;
        wheelX.current = 0;
        wheelLocked.current = true;
        setDragging(false);
        commitRef.current(card, dx > 0 ? "archive" : "trash");
      }
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => {
      el.removeEventListener("wheel", onWheel);
      if (wheelEndTimer.current) window.clearTimeout(wheelEndTimer.current);
    };
  }, [endWheelGesture, current?.key]);

  if (!current) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center px-8 py-16 text-center">
        <CheckCircle2 className="mb-3 h-14 w-14 text-white opacity-90" />
        <h2 className="text-xl font-semibold text-white">Deck clear</h2>
        <p className="mt-2 max-w-xs text-sm text-white/85">
          You’ve worked through the card stack. Pull to refresh or check Mail
          for anything new.
        </p>
        {onEmptyRefresh ? (
          <button
            type="button"
            onClick={onEmptyRefresh}
            className="mt-6 rounded-md bg-[var(--accent)] px-5 py-2.5 text-sm font-semibold text-white shadow-sm"
          >
            Refresh cards
          </button>
        ) : null}
      </div>
    );
  }

  const rotate = dragX / 28;
  const archiveHint = current.kind === "email" && dragX > 40;
  const trashHint = current.kind === "email" && dragX < -40;
  const currentBusy =
    current.kind === "email" && busyId === current.item.id;

  // The teal deck backdrop (.seer-deck-bg) is painted by the parent pane
  // so it can run full-bleed behind headers, previews, and empty states.
  return (
    <div className="flex flex-1 flex-col px-4 pb-2 pt-2">
      <div className="mb-3 flex items-center justify-between rounded-md bg-white/15 px-3 py-2">
        <div className="flex items-center gap-2 text-sm font-semibold text-white">
          <Layers className="h-4 w-4" />
          <span>Cards</span>
        </div>
        <span className="text-xs font-semibold text-white/90">
          {visible.length} left
        </span>
      </div>

      <div
        className="relative mx-auto w-full max-w-md flex-1"
        style={{ minHeight: 420 }}
      >
        {behind
          .slice()
          .reverse()
          .map((card, i, arr) => {
            const depth = arr.length - i;
            return (
              <div
                key={card.key}
                className="seer-card absolute inset-x-0 top-0"
                style={{
                  transform: `translateY(${depth * 10}px) scale(${1 - depth * 0.04})`,
                  opacity: 1 - depth * 0.15,
                  zIndex: 10 - depth,
                  transition:
                    "transform 0.4s cubic-bezier(0.22, 1.3, 0.36, 1), opacity 0.3s ease",
                }}
                aria-hidden
              >
                {card.kind === "email" ? (
                  <CardFace item={card.item} muted />
                ) : (
                  <BulkCardFace section={card.section} muted />
                )}
              </div>
            );
          })}

        <div
          ref={cardEl}
          className="seer-card absolute inset-x-0 top-0 z-20 touch-pan-y"
          style={{
            transform: `translateX(${dragX}px) rotate(${rotate}deg)`,
            // Springy settle — one overshoot, the brand motion curve
            transition: dragging
              ? "none"
              : "transform 0.5s cubic-bezier(0.22, 1.5, 0.36, 1)",
          }}
          onTouchStart={onTouchStart}
          onTouchMove={onTouchMove}
          onTouchEnd={onTouchEnd}
        >
          {archiveHint ? (
            <div className="pointer-events-none absolute left-4 top-6 z-30 rounded-lg bg-[#76ab19] px-3 py-1 text-xs font-bold uppercase tracking-wide text-white">
              Archive
            </div>
          ) : null}
          {trashHint ? (
            <div className="pointer-events-none absolute right-4 top-6 z-30 rounded-lg bg-[#d63b2f] px-3 py-1 text-xs font-bold uppercase tracking-wide text-white">
              Delete
            </div>
          ) : null}
          {current.kind === "email" ? (
            <CardFace
              item={current.item}
              busy={currentBusy}
              onTap={() => {
                if (Math.abs(dragX) < 8) onOpen(current.item.id);
              }}
              onSuggested={() => doSuggested(current.item, current)}
            />
          ) : (
            <BulkCardFace
              section={current.section}
              onConfirm={() =>
                commit(current, primaryMailAction(current.section.action))
              }
              onSkip={() => skip(current.key)}
            />
          )}
        </div>
      </div>

      {current.kind === "email" ? (
        <>
          <div className="mx-auto mt-4 flex w-full max-w-md items-center justify-around gap-1 pb-2">
            <CardAction
              label="Delete"
              color="#d63b2f"
              disabled={currentBusy}
              onClick={() => commit(current, "trash")}
            >
              <Trash2 className="h-5 w-5" />
            </CardAction>
            {onSnooze ? (
              <CardAction
                label="Snooze"
                color="var(--accent)"
                onClick={() => snoozeCard(current)}
              >
                <AlarmClock className="h-5 w-5" />
              </CardAction>
            ) : null}
            <CardAction
              label="Open"
              color="var(--muted)"
              onClick={() => onOpen(current.item.id)}
            >
              <MailOpen className="h-5 w-5" />
            </CardAction>
            <CardAction
              label="Reply"
              color="var(--primary)"
              onClick={() => onReply(current.item.id)}
            >
              <Reply className="h-5 w-5" />
            </CardAction>
            {onDelegate ? (
              <CardAction
                label="Delegate"
                color="#967ad0"
                disabled={currentBusy}
                onClick={() => delegateCard(current)}
              >
                <UserRoundPlus className="h-5 w-5" />
              </CardAction>
            ) : null}
            <CardAction
              label="Archive"
              color="#76ab19"
              disabled={currentBusy}
              onClick={() => commit(current, "archive")}
            >
              <Archive className="h-5 w-5" />
            </CardAction>
          </div>
          <p className="pb-2 text-center text-[11px] text-white/80">
            Swipe right to archive · left to delete — trackpad works too
          </p>
        </>
      ) : (
        <p className="pb-4 pt-4 text-center text-[11px] text-white/80">
          One tap clears the whole group — or decide one by one
        </p>
      )}
    </div>
  );
}

const BULK_VERB: Record<MailAction, string> = {
  trash: "Delete",
  archive: "Archive",
  read: "Mark read",
};

function BulkCardFace({
  section,
  muted,
  onConfirm,
  onSkip,
}: {
  section: Section;
  muted?: boolean;
  onConfirm?: () => void;
  onSkip?: () => void;
}) {
  const verb = BULK_VERB[primaryMailAction(section.action)];
  const shown = section.items.slice(0, 7);
  const extra = section.items.length - shown.length;
  return (
    <article
      className={`seer-card-face flex min-h-[380px] flex-col rounded-[22px] p-5 ${
        muted ? "pointer-events-none" : ""
      }`}
    >
      <div className="flex items-center gap-3">
        <div
          className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full text-white"
          style={{ backgroundColor: section.color }}
        >
          <Zap className="h-6 w-6" />
        </div>
        <div className="min-w-0 flex-1">
          <h3 className="text-[17px] font-semibold leading-snug">
            {verb} all of these?
          </h3>
          <p
            className="text-xs font-semibold uppercase tracking-wide"
            style={{ color: section.color }}
          >
            {section.label} · {section.items.length}
          </p>
        </div>
      </div>

      <ul className="mt-4 flex-1 space-y-2 overflow-hidden">
        {shown.map((item) => (
          <li key={item.id} className="flex items-baseline gap-2 text-[13px]">
            <span className="max-w-[38%] shrink-0 truncate font-medium">
              {item.fromName || item.fromEmail}
            </span>
            <span className="truncate text-[var(--muted)]">
              {item.subject}
            </span>
          </li>
        ))}
        {extra > 0 ? (
          <li className="text-[12px] font-medium text-[var(--muted)]">
            …and {extra} more
          </li>
        ) : null}
      </ul>

      {onConfirm ? (
        <div className="mt-4 space-y-2">
          <button
            type="button"
            onClick={onConfirm}
            className="w-full rounded-xl py-3 text-[15px] font-semibold text-white"
            style={{ backgroundColor: section.color }}
          >
            {verb} all {section.items.length}
          </button>
          <button
            type="button"
            onClick={onSkip}
            className="w-full rounded-xl border border-[var(--border)] py-2.5 text-sm font-medium text-[var(--muted)]"
          >
            Decide one by one
          </button>
        </div>
      ) : null}
    </article>
  );
}

const SUGGEST_VERB: Partial<Record<string, string>> = {
  respond: "Reply now",
  act_today: "Open it",
  needs_review: "Open it",
  delete_now: "Delete it",
  read_and_delete: "Delete it",
  unsubscribe: "Delete it",
  glance_promo: "Delete it",
  read_and_archive: "Archive it",
  review_subscription: "Archive it",
};

function CardFace({
  item,
  muted,
  busy,
  onTap,
  onSuggested,
}: {
  item: EmailItem;
  muted?: boolean;
  busy?: boolean;
  onTap?: () => void;
  onSuggested?: () => void;
}) {
  const g = item.guide;
  const accent = g?.color ?? "#2e7cf6";
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
      className={`seer-card-face flex min-h-[380px] flex-col rounded-[22px] p-5 ${
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
      <p className="mt-2 line-clamp-5 flex-1 text-[14px] leading-relaxed text-[var(--muted)]">
        {item.snippet || "No preview"}
      </p>

      {g ? (
        <div
          className="mt-4 rounded-xl px-3 py-3"
          style={{ backgroundColor: `${g.color}16` }}
        >
          <div
            className="text-xs font-bold uppercase tracking-wide"
            style={{ color: g.color }}
          >
            {g.label}
          </div>
          {g.instruction ? (
            <div className="mt-1 text-sm font-medium text-[var(--fg-strong)]">
              {g.instruction}
            </div>
          ) : null}
          {onSuggested && SUGGEST_VERB[g.action] ? (
            <button
              type="button"
              disabled={busy}
              onClick={(e) => {
                e.stopPropagation();
                onSuggested();
              }}
              className="mt-3 w-full rounded-lg py-2.5 text-sm font-semibold text-white disabled:opacity-50"
              style={{ backgroundColor: g.color }}
            >
              ✓ {SUGGEST_VERB[g.action]} — as suggested
            </button>
          ) : null}
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
        className="flex h-12 w-12 items-center justify-center rounded-full bg-white shadow-[0_2px_8px_rgba(10,45,40,0.25)]"
        style={{ color }}
      >
        {children}
      </span>
      <span className="text-[10px] font-medium text-white/85">{label}</span>
    </button>
  );
}
