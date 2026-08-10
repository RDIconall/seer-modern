/**
 * Tying related conversations into ONE unit of work.
 *
 * The unit is the REQUEST, not the topic and not the sender: four emails from
 * the same person at the same company about the same request, where the user's
 * next move is one action, are one thing on the desk — not four.
 *
 * Mis-tying is worse than not tying, so the join is deliberately conservative:
 * a shared study/event code is treated as proof, and otherwise we require the
 * same counterparty AND real overlap in the request itself. Loose topic
 * similarity alone never merges.
 */

/**
 * Project, study, and sourcing-event codes used across this corpus:
 * RD007704, RCD_2818, BIM_2747, LMD_2801, TGRP32, EUR2875, TZC0430556,
 * 2026P-073. These are the most reliable identity signal available — when two
 * conversations carry the same code they are the same work.
 */
// Note: a trailing \b is wrong here — codes are routinely followed by an
// underscore ("TZC0430556_MC", "RCD_2818_TMS") and `_` is a word character, so
// \b never fires. A negative lookahead on digits is the correct terminator.
const CODE_PATTERNS: RegExp[] = [
  /\b(?:LABSOP|RCD|TGRP|CAPA|QMP|CLP|BIM|LMD|EUR|SOP|RD|WI)[-_ ]?\d{1,7}(?!\d)/gi,
  /\bTZC\d{5,9}(?!\d)/gi,
  /\b\d{4}P-\d{3}(?!\d)/gi,
  /\bRFQ[-_ ]?\d{3,6}(?!\d)/gi,
];

/** Words that carry no identifying signal when comparing two requests. */
const STOP = new Set([
  "the", "and", "for", "with", "from", "your", "you", "our", "this", "that",
  "request", "requests", "update", "updates", "re", "fw", "fwd", "new", "draft",
  "please", "regarding", "about", "study", "sample", "samples", "email",
  "meeting", "call", "review", "reviewed", "action", "inform", "notification",
]);

export function extractCodes(text: string): string[] {
  const found = new Set<string>();
  for (const pattern of CODE_PATTERNS) {
    for (const match of text.matchAll(pattern)) {
      // Normalize RD 007704 / RD-007704 / rd_007704 to a single key.
      found.add(match[0].toUpperCase().replace(/[-_\s]/g, ""));
    }
  }
  return [...found];
}

/** The counterparty a conversation belongs to, from the sender's domain. */
const FREEMAIL = /^(gmail|googlemail|outlook|hotmail|live|yahoo|icloud|me|aol|proton|protonmail)\./;

export function counterpartyOf(fromEmail: string, ownDomain: string): string {
  const domain = (fromEmail.split("@")[1] ?? "").toLowerCase();
  if (!domain) return "";
  if (ownDomain && domain === ownDomain.toLowerCase()) return "internal";
  const bare = domain.replace(
    /^(mail|email|e|smtp|notifications?|no-?reply|info|reply|bounce|em|mailer|send|go|links?|vendor|global|list|news|newsletters?)\./,
    "",
  );
  if (!bare || FREEMAIL.test(`${bare}.`)) return "";
  return bare.split(".")[0];
}

export function significantWords(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/[^a-z0-9\s-]/g, " ")
      .split(/\s+/)
      .filter((w) => w.length > 3 && !STOP.has(w)),
  );
}

export type MatterCandidate = {
  matterId: string;
  title: string;
  /** Codes already associated with this matter. */
  codes: string[];
  counterparty: string;
};

export type ConversationKey = {
  /** Proposed matter name from the read, or the subject as a fallback. */
  title: string;
  /** Text to mine for codes: subject + proposed name + body excerpt. */
  text: string;
  counterparty: string;
};

/** How much request overlap is required to tie two conversations together. */
const MIN_SHARED_WORDS = 2;

/**
 * Find the existing matter this conversation belongs to, or null to start a new
 * one. A shared code wins outright; otherwise the counterparty must match AND
 * the requests must share real vocabulary.
 */
export function resolveMatterMatch(
  key: ConversationKey,
  candidates: MatterCandidate[],
): MatterCandidate | null {
  const codes = extractCodes(key.text);
  const words = significantWords(key.title);

  // 1. Same code = same work. Strongest and cheapest signal.
  if (codes.length > 0) {
    for (const candidate of candidates) {
      if (candidate.codes.some((c) => codes.includes(c))) return candidate;
    }
  }

  // 2. Same counterparty AND overlapping request vocabulary.
  if (!key.counterparty) return null;
  let best: { candidate: MatterCandidate; score: number } | null = null;
  for (const candidate of candidates) {
    if (candidate.counterparty !== key.counterparty) continue;
    const candidateWords = significantWords(candidate.title);
    let shared = 0;
    for (const w of words) if (candidateWords.has(w)) shared++;
    if (shared >= MIN_SHARED_WORDS && (!best || shared > best.score)) {
      best = { candidate, score: shared };
    }
  }
  return best?.candidate ?? null;
}
