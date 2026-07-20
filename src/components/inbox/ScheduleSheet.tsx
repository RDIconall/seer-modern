"use client";

import { CalendarClock, Loader2, X } from "lucide-react";
import { useMemo, useState } from "react";

/**
 * "Schedule it" — time-blocking from an email. The ask is pulled out
 * and shown plainly; pick a slot and a duration, Seer books the block
 * and archives the email (the calendar is the todo list, not the inbox).
 */

export type SchedulePayload = {
  title: string;
  startsAt: string;
  durationMins: number;
};

function fmtSlot(d: Date): string {
  const today = new Date();
  const tomorrow = new Date(today);
  tomorrow.setDate(today.getDate() + 1);
  const day =
    d.toDateString() === today.toDateString()
      ? "Today"
      : d.toDateString() === tomorrow.toDateString()
        ? "Tomorrow"
        : d.toLocaleDateString([], { weekday: "short" });
  return `${day} ${d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`;
}

function toLocalInput(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** Sensible quick slots: next hour today (if daytime), tomorrow 9a / 2p. */
function quickSlots(): Date[] {
  const out: Date[] = [];
  const now = new Date();
  const nextHour = new Date(now);
  nextHour.setMinutes(0, 0, 0);
  nextHour.setHours(nextHour.getHours() + 1);
  if (nextHour.getHours() >= 7 && nextHour.getHours() <= 20) {
    out.push(nextHour);
  }
  const tmrw9 = new Date(now);
  tmrw9.setDate(now.getDate() + 1);
  tmrw9.setHours(9, 0, 0, 0);
  out.push(tmrw9);
  const tmrw14 = new Date(tmrw9);
  tmrw14.setHours(14);
  out.push(tmrw14);
  return out.slice(0, 3);
}

export function ScheduleSheet({
  subject,
  ask,
  busy,
  onConfirm,
  onClose,
}: {
  subject: string;
  ask?: string;
  busy: boolean;
  onConfirm: (payload: SchedulePayload) => void;
  onClose: () => void;
}) {
  const slots = useMemo(quickSlots, []);
  const [title, setTitle] = useState(
    ask ? ask.replace(/[?.!]\s*$/, "") : subject,
  );
  const [duration, setDuration] = useState(30);
  const [slotIdx, setSlotIdx] = useState(0);
  const [custom, setCustom] = useState("");

  const startsAt = custom
    ? new Date(custom)
    : (slots[slotIdx] ?? slots[0]);
  const valid =
    title.trim().length > 0 &&
    startsAt instanceof Date &&
    !Number.isNaN(startsAt.getTime());

  return (
    <div className="fixed inset-0 z-[60] flex items-end justify-center bg-black/40 sm:items-center">
      <button
        type="button"
        aria-label="Close"
        className="absolute inset-0"
        onClick={onClose}
      />
      <div className="relative w-full max-w-md rounded-t-2xl bg-[var(--bg)] p-5 shadow-2xl sm:rounded-2xl">
        <div className="mb-1 flex items-center justify-between">
          <h2 className="flex items-center gap-2 text-[16px] font-semibold">
            <CalendarClock className="h-4 w-4 text-[var(--primary)]" />
            Schedule it
          </h2>
          <button
            type="button"
            onClick={onClose}
            className="rounded-full p-1.5 text-[var(--muted)] hover:bg-[var(--card)]"
            aria-label="Close"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {ask ? (
          <div className="mb-3 rounded-xl border-l-4 border-[var(--primary)] bg-[var(--primary-soft,rgba(52,152,217,0.08))] px-3 py-2">
            <div className="text-[10px] font-semibold uppercase tracking-wide text-[var(--primary)]">
              What needs doing
            </div>
            <p className="mt-0.5 text-[13px] font-medium leading-snug">
              “{ask}”
            </p>
          </div>
        ) : (
          <p className="mb-3 truncate text-[12px] text-[var(--muted)]">
            {subject}
          </p>
        )}

        <label className="mb-1 block text-[11px] font-semibold uppercase tracking-wide text-[var(--muted)]">
          Block title
        </label>
        <input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          className="mb-3 w-full rounded-xl border border-[var(--border)] bg-[var(--bg)] px-3 py-2.5 text-sm outline-none focus:border-[var(--primary)]"
        />

        <label className="mb-1 block text-[11px] font-semibold uppercase tracking-wide text-[var(--muted)]">
          When
        </label>
        <div className="mb-2 flex flex-wrap gap-1.5">
          {slots.map((s, i) => (
            <button
              key={s.toISOString()}
              type="button"
              onClick={() => {
                setSlotIdx(i);
                setCustom("");
              }}
              className={`rounded-full px-3 py-1.5 text-[12px] font-medium ${
                !custom && slotIdx === i
                  ? "bg-[var(--primary)] text-white"
                  : "bg-[var(--card)] text-[var(--fg)]"
              }`}
            >
              {fmtSlot(s)}
            </button>
          ))}
        </div>
        <input
          type="datetime-local"
          value={custom}
          min={toLocalInput(new Date())}
          onChange={(e) => setCustom(e.target.value)}
          className="mb-3 w-full rounded-xl border border-[var(--border)] bg-[var(--bg)] px-3 py-2 text-sm outline-none focus:border-[var(--primary)]"
        />

        <label className="mb-1 block text-[11px] font-semibold uppercase tracking-wide text-[var(--muted)]">
          How long
        </label>
        <div className="mb-4 flex gap-1.5">
          {[15, 30, 60].map((m) => (
            <button
              key={m}
              type="button"
              onClick={() => setDuration(m)}
              className={`rounded-full px-3 py-1.5 text-[12px] font-medium ${
                duration === m
                  ? "bg-[var(--primary)] text-white"
                  : "bg-[var(--card)] text-[var(--fg)]"
              }`}
            >
              {m === 60 ? "1 hour" : `${m} min`}
            </button>
          ))}
        </div>

        <button
          type="button"
          disabled={!valid || busy}
          onClick={() =>
            onConfirm({
              title: title.trim(),
              startsAt: startsAt.toISOString(),
              durationMins: duration,
            })
          }
          className="flex w-full items-center justify-center gap-2 rounded-xl bg-[var(--primary)] py-3 text-[15px] font-semibold text-white disabled:opacity-50"
        >
          {busy ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <CalendarClock className="h-4 w-4" />
          )}
          {busy
            ? "Booking…"
            : valid
              ? `Block ${duration === 60 ? "1 hour" : `${duration} min`} · ${fmtSlot(startsAt)}`
              : "Pick a time"}
        </button>
        <p className="mt-2 text-center text-[11px] text-[var(--muted)]">
          The event links back to this email — the email itself gets archived.
        </p>
      </div>
    </div>
  );
}
