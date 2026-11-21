/**
 * The phrase every read schema requires when nothing is owed. An ask counts
 * as empty only when it IS this phrase — text that merely starts with
 * "nothing" can still carry a request after it, and model output is shaped
 * by the mail being read.
 */
export const EMPTY_ASK = "nothing — informational";

function normalize(ask: string): string {
  return ask
    .trim()
    .replace(/\s+/g, " ")
    .replace(/\s*[-–—]\s*/g, " — ")
    .toLowerCase();
}

export function isEmptyAsk(ask: string | null | undefined): boolean {
  return typeof ask === "string" && normalize(ask) === EMPTY_ASK;
}

/** A stated ask that is anything other than the empty phrase. */
export function hasOpenAsk(ask: string | null | undefined): boolean {
  return typeof ask === "string" && ask.trim() !== "" && !isEmptyAsk(ask);
}
