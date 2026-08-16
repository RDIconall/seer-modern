/**
 * TRIAGE ORDER — what "most likely to delete" means, in one place.
 *
 * Triage is not a separate screen; it is a way of sorting the inbox. Instead of
 * newest first, the list leads with the mail Seer's current decision says is
 * disposable and ends with the work. The rank below is the whole definition,
 * and the mailbox query orders by exactly these numbers, so the SQL and the
 * group headings in the list can never disagree about where a row belongs.
 *
 * The order is deliberate on one point: a conversation the safety layer VETOED
 * ranks below a plain record. A veto exists to stop a deletion, so the vetoed
 * mail must never be presented at the top of a list titled "most likely to
 * delete". Only `delete` rows carry a signed token, so even if this order were
 * wrong, a bulk delete still could not touch anything else.
 */

export type Disposition =
  | "delete"
  | "record"
  | "undecided"
  | "matter"
  /** No current decision — Seer has not read it, so it claims nothing. */
  | "pending";

/** Most likely to delete first. Index is the rank the mailbox query sorts by. */
export const TRIAGE_ORDER: Disposition[] = [
  "delete",
  "record",
  "undecided",
  "matter",
  "pending",
];

export function deleteRank(disposition: Disposition): number {
  const rank = TRIAGE_ORDER.indexOf(disposition);
  return rank === -1 ? TRIAGE_ORDER.length : rank;
}

/** The stored decision `home` mapped to a disposition; no row is left out. */
export function dispositionFromHome(home: string | null | undefined): Disposition {
  switch (home) {
    case "delete":
      return "delete";
    case "record":
      return "record";
    case "matter":
      return "matter";
    case "undecided":
      return "undecided";
    default:
      return "pending";
  }
}

/**
 * The heading a run of rows sits under. Plain language, because the user is
 * scanning for what to clear, not reading a taxonomy.
 */
export function triageGroupLabel(disposition: Disposition): string {
  switch (disposition) {
    case "delete":
      return "Ready to clear";
    case "record":
      return "Filed for the record";
    case "undecided":
      return "Needs you";
    case "matter":
      return "Live matters";
    case "pending":
      return "Not read yet";
  }
}

/** One line saying why a run of rows is where it is. */
export function triageGroupHint(disposition: Disposition): string {
  switch (disposition) {
    case "delete":
      return "Seer cleared these for deletion.";
    case "record":
      return "Worth keeping, but nothing is being asked of you.";
    case "undecided":
      return "Seer wanted to bin these and something stopped it.";
    case "matter":
      return "Live work. Deleting these needs your say-so.";
    case "pending":
      return "Still being read.";
  }
}
