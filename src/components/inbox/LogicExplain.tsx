"use client";

import { ACTION_META, type TriageAction } from "@/lib/inbox/classify";
import { stripEmoji, type Guide } from "@/lib/inbox/types";

export type TeachHandler = (action: TriageAction) => void;

/**
 * Correcting a verdict is a user ACTION, not an explanation. What used to
 * live here — the reason, the confidence, the deciding engine, the rule
 * id, the relationship counters — was the assistant narrating itself.
 * All that remains is the read (what the email means) and the four
 * corrections a person actually makes.
 */
export const TEACH_CHOICES: { action: TriageAction; label: string }[] = [
  { action: "act_today", label: "Needs me" },
  { action: "read_and_archive", label: "Archive" },
  { action: "delete_now", label: "Delete" },
  { action: "unsubscribe", label: "Unsubscribe" },
];

/** Which teach choice a current verdict belongs to — hidden as redundant. */
export function teachGroup(action: TriageAction): TriageAction {
  switch (action) {
    case "respond":
    case "act_today":
    case "needs_review":
      return "act_today";
    case "delete_now":
    case "read_and_delete":
    case "glance_promo":
      return "delete_now";
    case "unsubscribe":
      return "unsubscribe";
    default:
      return "read_and_archive";
  }
}

function TeachRow({
  guide,
  onTeach,
}: {
  guide: Guide;
  onTeach: TeachHandler;
}) {
  const current = teachGroup(guide.action);
  return (
    <span className="flex shrink-0 items-center gap-1">
      {TEACH_CHOICES.filter((c) => c.action !== current).map((c) => (
        <button
          key={c.action}
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onTeach(c.action);
          }}
          className="rounded px-1.5 py-0.5 text-[12px] text-white"
          style={{ backgroundColor: ACTION_META[c.action].color }}
        >
          {c.label}
        </button>
      ))}
    </span>
  );
}

/** One line in a list row: what this email is. Nothing about how we know. */
export function LogicExplain({ guide }: { guide: Guide }) {
  const text = stripEmoji(guide.task ?? guide.label);
  if (!text) return null;
  return (
    <div className="flex min-w-0 items-center gap-1.5">
      {guide.category ? (
        <span className="shrink-0 rounded bg-[var(--card)] px-1 text-[12px] text-[var(--muted)]">
          {guide.category}
        </span>
      ) : null}
      <span
        className="truncate text-[12px]"
        style={{ color: guide.color }}
      >
        {text}
      </span>
    </div>
  );
}

/** Reader: the read on one line, with the corrections inline beside it. */
export function ReaderGuideBar({
  guide,
  onTeach,
}: {
  guide: Guide;
  onTeach?: TeachHandler;
}) {
  const text = stripEmoji(guide.task ?? guide.label);
  return (
    <div
      className="mt-2 flex items-center gap-2 rounded px-2 py-1"
      style={{
        backgroundColor: `${guide.color}12`,
        border: `1px solid ${guide.color}40`,
      }}
    >
      <span
        className="h-1.5 w-1.5 shrink-0 rounded-full"
        style={{ backgroundColor: guide.color }}
        aria-hidden
      />
      <span
        className="min-w-0 flex-1 truncate text-[14px]"
        style={{ color: guide.color }}
      >
        {text}
      </span>
      {onTeach ? <TeachRow guide={guide} onTeach={onTeach} /> : null}
    </div>
  );
}
