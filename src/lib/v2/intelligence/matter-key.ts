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

/**
 * Words that say people TALKED without saying what the work is. A model
 * reading one conversation at a time falls back on these — "RDI engagement /
 * Conall call" — and because every email in the mailbox involves the user,
 * such a name fits everything. Eleven separate concerns were once filed under
 * that exact title, and four unrelated pieces of internal work merged into one
 * matter because the repeated vague title acted as their tie.
 *
 * These words may appear in a name; they just never COUNT as evidence that two
 * conversations are the same work.
 */
const VAGUE = new Set([
  "engagement", "call", "calls", "chat", "sync", "intro", "introduction",
  "catch", "catchup", "connect", "connecting", "connection", "conversation",
  "discussion", "followup", "follow", "outreach", "touch", "touchpoint",
  "checkin", "check", "hello", "thanks", "today", "great",
]);

/**
 * The user's own identity, as match-noise. Every matter on this desk involves
 * the user and their company, so their names identify nothing. Derived from
 * the account email ("conall@rditrials.com" → conall, rditrials), plus any
 * display-name words the caller knows.
 */
export function ownTokens(ownEmail: string, ownName?: string): Set<string> {
  const tokens = new Set<string>();
  const [local, domain] = ownEmail.toLowerCase().split("@");
  for (const t of (local ?? "").split(/[._-]/)) if (t) tokens.add(t);
  const firstLabel = (domain ?? "").split(".")[0];
  if (firstLabel) tokens.add(firstLabel);
  for (const t of (ownName ?? "").toLowerCase().split(/\s+/)) {
    if (t) tokens.add(t);
  }
  return tokens;
}

/** The words in a name that actually identify work. */
export function informativeWords(text: string, own?: Set<string>): Set<string> {
  const words = significantWords(text);
  for (const w of [...words]) {
    if (VAGUE.has(w) || own?.has(w)) words.delete(w);
  }
  return words;
}

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

/**
 * A readable name for a unit of work when the read didn't supply one. An email
 * subject is not a matter name — "INFORM: New post in discussion: 024146-Jul2026
 * by Raiane Sousa Gaspar" describes a notification, not a concern. Strip the
 * transport noise and, where a code and counterparty exist, name it after the
 * work itself.
 */
export function matterNameFrom(
  proposed: string | undefined,
  subject: string,
  counterparty: string,
  text: string,
  own?: Set<string>,
): string {
  const clean = (s: string) =>
    s
      .replace(/^(?:re|fw|fwd|inform|action|reminder|notification|automatic reply)\s*:\s*/gi, "")
      .replace(/\s+/g, " ")
      .trim();

  // A proposal is only a name if it names WORK. "RDI engagement / Conall
  // call" survives every format check and identifies nothing — the user and a
  // conversation are present in every matter on the desk. Reject it and let
  // the code/subject path produce something that actually distinguishes.
  const fromModel = proposed?.trim();
  if (
    fromModel &&
    !/^(?:re|fw|fwd|inform|action)\s*:/i.test(fromModel) &&
    (informativeWords(fromModel, own).size > 0 ||
      extractCodes(fromModel).length > 0)
  ) {
    return fromModel.slice(0, 120);
  }

  const codes = extractCodes(text);
  const company = counterparty && counterparty !== "internal" ? titleCase(counterparty) : "";
  if (codes.length > 0) {
    return [company, codes[0]].filter(Boolean).join(" ").slice(0, 120);
  }

  const stripped = clean(subject);
  if (stripped) {
    return (company && !stripped.toLowerCase().includes(counterparty)
      ? `${company} — ${stripped}`
      : stripped
    ).slice(0, 120);
  }
  return company || "Untitled matter";
}

function titleCase(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/**
 * Resolve an explicitly NAMED matter reference (from a yield) to an existing
 * matter. Unlike conversation tying, the sender's counterparty is irrelevant
 * here — a 360Dx newsletter can legitimately reference a Roche matter. The
 * reference is a claim about subject, so it matches on codes and on the words
 * of the name itself. It never creates a matter.
 */
export function resolveMatterByRef(
  ref: string,
  candidates: MatterCandidate[],
): MatterCandidate | null {
  const normalized = ref.toLowerCase().trim();
  const exact = candidates.find((c) => c.title.toLowerCase().trim() === normalized);
  if (exact) return exact;

  const codes = extractCodes(ref);
  if (codes.length > 0) {
    const byCode = candidates.find((c) => c.codes.some((code) => codes.includes(code)));
    if (byCode) return byCode;
  }

  const words = significantWords(ref);
  let best: { candidate: MatterCandidate; score: number } | null = null;
  for (const candidate of candidates) {
    const candidateWords = significantWords(candidate.title);
    let shared = 0;
    for (const w of words) if (candidateWords.has(w)) shared++;
    if (shared >= MIN_SHARED_WORDS && (!best || shared > best.score)) {
      best = { candidate, score: shared };
    }
  }
  return best?.candidate ?? null;
}

export type MatterCandidate = {
  matterId: string;
  title: string;
  /** Codes already associated with this matter. */
  codes: string[];
  counterparty: string;
  /** The user named this matter themselves, so its scope is their decision. */
  userAuthored?: boolean;
};

export type ConversationKey = {
  /** Proposed matter name from the read, or the subject as a fallback. */
  title: string;
  /** Text to mine for codes: subject + proposed name + body excerpt. */
  text: string;
  counterparty: string;
  /** The user's own name/company tokens — never evidence of shared work. */
  own?: Set<string>;
};

/** How much request overlap is required to tie two conversations together. */
const MIN_SHARED_WORDS = 2;

/** Compare matter names as work, not as strings: case and spacing are noise. */
function normalizeTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/**
 * Find the existing matter this conversation belongs to, or null to start a new
 * one. A shared code wins outright, then an identical name; otherwise the
 * counterparty must match AND the requests must share real vocabulary.
 */
export function resolveMatterMatch(
  key: ConversationKey,
  candidates: MatterCandidate[],
): MatterCandidate | null {
  const codes = extractCodes(key.text);
  // Only words that identify WORK count toward a tie. "RDI engagement /
  // Conall call" shares three words with its own duplicates and none of them
  // say what the work is — without this, four unrelated internal concerns
  // merged because a model kept proposing the same vague name.
  const words = informativeWords(key.title, key.own);

  // 1. Same code = same work. Strongest and cheapest signal.
  if (codes.length > 0) {
    for (const candidate of candidates) {
      if (candidate.codes.some((c) => codes.includes(c))) return candidate;
    }
  }

  // 2. A matter the user named themselves is authoritative: they have already
  // said this is one unit of work. Mail reaches it from every side — the
  // vendor, a colleague, a portal — so matching it on counterparty would
  // fragment the very grouping the user asked for. Inferred matters get no
  // such licence; they must still prove the counterparty below.
  const normalized = normalizeTitle(key.title);
  if (normalized) {
    for (const candidate of candidates) {
      if (!candidate.userAuthored) continue;
      if (normalizeTitle(candidate.title) === normalized) return candidate;
    }
  }

  // 3. Same counterparty AND overlapping request vocabulary.
  if (!key.counterparty) return null;
  let best: { candidate: MatterCandidate; score: number } | null = null;
  for (const candidate of candidates) {
    if (candidate.counterparty !== key.counterparty) continue;
    const candidateWords = informativeWords(candidate.title, key.own);
    let shared = 0;
    for (const w of words) if (candidateWords.has(w)) shared++;
    if (shared >= MIN_SHARED_WORDS && (!best || shared > best.score)) {
      best = { candidate, score: shared };
    }
  }
  return best?.candidate ?? null;
}
