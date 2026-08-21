import type { Disposition } from "./triage-rank";
import type { MailboxRow } from "./types";

/**
 * Triage in four verbs.
 *
 * The piles used to be named after what Seer had concluded — "filed for the
 * record", "needs a look" — which is Seer talking about itself. These are named
 * after what the user is about to do, because that is the only thing they are
 * deciding: delete it, file it, answer it, or keep it.
 *
 * Keep is the interesting one. Anything not deleted and not filed is live work,
 * so keeping it puts it on the whiteboard as a matter. Triage is therefore the
 * mouth of Atlas: mail leaves here in one of four directions and only one of
 * them ends on the board.
 */
export type TriageVerb = "delete" | "file" | "answer" | "keep";

/**
 * Action likelihood, highest first. Triage is a work queue rather than four
 * equal buckets: clear the obvious deletes, archive the records, then spend
 * attention on replies and live work.
 */
export const VERB_ORDER: TriageVerb[] = ["delete", "file", "answer", "keep"];

export const VERB_LABEL: Record<TriageVerb, string> = {
  delete: "Delete",
  file: "Archive",
  answer: "Answer",
  keep: "Atlas",
};

export const VERB_HINT: Record<TriageVerb, string> = {
  delete: "Most likely next action",
  file: "Receipts and records",
  answer: "Waiting on you",
  keep: "Live work",
};

/**
 * Likely user action for triage presentation.
 *
 * Prefer `proposedDisposition` when the decision recorded one: a safety veto
 * can leave durable `home` as undecided while the model still believed delete
 * (or record). Grouping by that proposal puts the row where the user is most
 * likely to act.
 *
 * Presentation only. Reading the proposal does not mint a delete token, does
 * not change durable home, and does not bypass automated deletion safety —
 * row-level delete still goes `{ byUser: true }`, and pile sweeps still need a
 * signed token on durable delete.
 */
export function likelyDisposition(row: MailboxRow): Disposition {
  return row.proposedDisposition ?? row.disposition;
}

/**
 * Which pile a conversation is in.
 *
 * Likely delete outranks everything, including a veto that parked durable home
 * at undecided. Owing a reply outranks every non-delete likelihood: a thread
 * the user owes a move on is work, and burying it under "keep" is how a reply
 * goes unsent for a fortnight.
 */
export function verbFor(row: MailboxRow): TriageVerb {
  const likely = likelyDisposition(row);
  if (likely === "delete") return "delete";
  if (row.owner === "you") return "answer";
  if (likely === "record") return "file";
  return "keep";
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
export type TriagePile = { verb: TriageVerb; label: string; count: number; days: TriageDay[] };

/**
 * Shape the mailbox into piles, each broken into days, newest first. Rows the
 * caller has already dismissed (Atlas only — Delete/Archive leave via the
 * mailbox optimistic removal) are gone from here.
 */
export function triagePiles(
  rows: MailboxRow[],
  dismissed: ReadonlySet<string>,
  now = Date.now(),
): TriagePile[] {
  const byVerb = new Map<TriageVerb, MailboxRow[]>();
  for (const row of rows) {
    if (dismissed.has(row.conversationId)) continue;
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
    piles.push({ verb, label: VERB_LABEL[verb], count: list.length, days });
  }
  return piles;
}
