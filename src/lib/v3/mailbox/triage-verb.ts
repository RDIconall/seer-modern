import type { MailboxRow } from "./types";

/**
 * Triage has three destinations, and every conversation leaves by one of them:
 * it becomes a matter on Atlas, it is archived for the record, or it is
 * deleted. That is the whole point of the screen — an inbox is emptied by
 * deciding where things go, not by relabelling them.
 *
 * The piles this file produces are named after the destination, not after a
 * verb describing the user's mood about the mail. "File", "Answer" and "Keep"
 * all meant "still in the inbox afterwards", which is how a triage screen ends
 * a session with the same rows it started with.
 */
export type TriageVerb = "delete" | "archive" | "matter";

export const VERB_ORDER: TriageVerb[] = ["delete", "archive", "matter"];

export const VERB_LABEL: Record<TriageVerb, string> = {
  delete: "Delete",
  archive: "Archive",
  matter: "Atlas",
};

/** What each pile is for, said once above the rows rather than on each of them. */
export const VERB_HINT: Record<TriageVerb, string> = {
  delete: "Nothing here is worth keeping.",
  archive: "Worth keeping, but nothing is being asked of you.",
  matter: "Live work — these belong on the whiteboard.",
};

/**
 * Where a conversation is headed.
 *
 * Only two dispositions have a destination of their own: Seer cleared it for
 * deletion, or it is a record. Everything else is live work and belongs on
 * Atlas, including mail Seer has not finished reading — an undecided
 * conversation is a decision the user still owes, and the board is where they
 * owe it.
 */
export function verbFor(row: MailboxRow): TriageVerb {
  if (row.disposition === "delete") return "delete";
  if (row.disposition === "record") return "archive";
  return "matter";
}

/**
 * The day a row belongs to, as a person reads days: today, yesterday, then a
 * date. Seer groups the mail; the mail keeps its own dates inside that.
 */
export function dayLabel(timestamp: string, now = Date.now()): string {
  const at = Date.parse(timestamp);
  if (Number.isNaN(at)) return "Earlier";
  const startOf = (ms: number) => {
    const d = new Date(ms);
    return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  };
  const days = Math.round((startOf(now) - startOf(at)) / 86_400_000);
  if (days <= 0) return "Today";
  if (days === 1) return "Yesterday";
  const d = new Date(at);
  const sameYear = d.getFullYear() === new Date(now).getFullYear();
  return d.toLocaleDateString(undefined, {
    weekday: days < 7 ? "short" : undefined,
    day: "numeric",
    month: "short",
    year: sameYear ? undefined : "numeric",
  });
}

/** The clock time for a row from today, and nothing for older mail. */
export function timeLabel(timestamp: string, now = Date.now()): string {
  if (dayLabel(timestamp, now) !== "Today") return "";
  const at = Date.parse(timestamp);
  if (Number.isNaN(at)) return "";
  return new Date(at).toLocaleTimeString(undefined, {
    hour: "numeric",
    minute: "2-digit",
  });
}

export type TriageDay = { day: string; rows: MailboxRow[] };
export type TriagePile = {
  verb: TriageVerb;
  label: string;
  hint: string;
  count: number;
  days: TriageDay[];
};

/**
 * Shape the mailbox into piles, each broken into days, newest first. Rows the
 * user has already settled are gone from here — they have left the inbox.
 */
export function triagePiles(
  rows: MailboxRow[],
  settled: ReadonlySet<string>,
  now = Date.now(),
): TriagePile[] {
  const byVerb = new Map<TriageVerb, MailboxRow[]>();
  for (const row of rows) {
    if (settled.has(row.conversationId)) continue;
    const verb = verbFor(row);
    const list = byVerb.get(verb) ?? [];
    list.push(row);
    byVerb.set(verb, list);
  }

  const piles: TriagePile[] = [];
  for (const verb of VERB_ORDER) {
    const list = byVerb.get(verb);
    if (!list || list.length === 0) continue;
    const ordered = [...list].sort(
      (a, b) => Date.parse(b.timestamp || "") - Date.parse(a.timestamp || ""),
    );
    const days: TriageDay[] = [];
    for (const row of ordered) {
      const day = dayLabel(row.timestamp, now);
      const last = days[days.length - 1];
      if (last && last.day === day) last.rows.push(row);
      else days.push({ day, rows: [row] });
    }
    piles.push({
      verb,
      label: VERB_LABEL[verb],
      hint: VERB_HINT[verb],
      count: list.length,
      days,
    });
  }
  return piles;
}
