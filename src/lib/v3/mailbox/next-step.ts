import type { Disposition } from "./triage-rank";

/**
 * What the Inbox says should happen next to a row, in one place.
 *
 * A matter carries the words of the work ("Send redlined MSA to Roche legal");
 * a conversation Seer has not placed on a matter carries a verb the person can
 * agree to in bulk. The server decides both so the list never re-derives them.
 */

export type NextVerb = "delete" | "archive" | "record";

export const NEXT_VERB_LABEL: Record<NextVerb, string> = {
  delete: "Delete",
  archive: "Archive",
  record: "Keep for record",
};

export type NextStep = {
  /** Present for conversations that are not part of a matter; null on matters. */
  verb: NextVerb | null;
  /** The words shown in the Next step column. */
  text: string;
  /** Who wrote it: the person, Seer's reading, or a generic fallback. */
  source: "user" | "seer" | "default";
};

const NOTHING = /^\s*nothing\b/i;
const MAX_TEXT = 140;

function clip(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > MAX_TEXT ? `${flat.slice(0, MAX_TEXT - 1).trimEnd()}…` : flat;
}

/** The verb a conversation that is not on a matter is proposed for. */
export function verbForDisposition(disposition: Disposition): NextVerb {
  if (disposition === "delete") return "delete";
  if (disposition === "record") return "record";
  return "archive";
}

export function nextStepFor(input: {
  disposition: Disposition;
  matterId: string | null;
  /** Seer's `ask` for this conversation: the specific thing wanted. */
  ask: string | null;
  /** Seer's one-line reading of the conversation. */
  summary: string | null;
  /** The person's own wording, stored on the matter. */
  userStep: string | null;
}): NextStep {
  if (input.matterId) {
    const user = input.userStep?.trim();
    if (user) return { verb: null, text: clip(user), source: "user" };
    const ask = input.ask?.trim();
    if (ask && !NOTHING.test(ask)) return { verb: null, text: clip(ask), source: "seer" };
    return {
      verb: null,
      text: "Review the latest conversation",
      source: "default",
    };
  }

  const verb = verbForDisposition(input.disposition);
  const reason = input.summary?.trim() || input.ask?.trim() || "";
  return {
    verb,
    text: reason ? clip(reason) : NEXT_VERB_LABEL[verb],
    source: reason ? "seer" : "default",
  };
}
