/**
 * Old-Seer signature move: pull the actionable SENTENCE out of the
 * email — "can you complete this form?" — and put it in front of the
 * user. Local + free, works on every message.
 */

const REQUEST_PATTERNS: { re: RegExp; score: number }[] = [
  { re: /\bcan you\b|\bcould you\b|\bwould you\b|\bwill you\b/i, score: 10 },
  { re: /\bplease\b/i, score: 7 },
  { re: /\bdo you mind\b|\bare you able\b|\bany chance\b/i, score: 9 },
  { re: /\bneed you to\b|\bwaiting on you\b|\baction required\b/i, score: 9 },
  { re: /\b(complete|fill out|fill in) (this|the|that) (form|survey|doc)/i, score: 10 },
  { re: /\b(sign|review|approve|confirm|verify|send|share|schedule|book|call|upload|submit|forward|update)\b/i, score: 5 },
  { re: /\blet me know\b|\bget back to me\b|\bthoughts\??/i, score: 6 },
  { re: /\bby (monday|tuesday|wednesday|thursday|friday|saturday|sunday|tomorrow|today|eod|end of (day|week)|\d{1,2}(\/|-)\d{1,2})/i, score: 6 },
  { re: /\?\s*$/, score: 4 },
];

const NOISE =
  /unsubscribe|privacy policy|terms of|view in browser|copyright|all rights reserved|sent from my|confidential/i;

/** Greeting/sign-off shapes that are never the ask. */
const FILLER =
  /^(hi|hey|hello|dear|thanks|thank you|best|regards|cheers|sincerely|awesome|great|sounds good)[,!. ]|^\s*$/i;

function sentences(text: string): string[] {
  return text
    .replace(/\s+/g, " ")
    .split(/(?<=[.!?])\s+|\n+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

export function extractAsk(bodyText: string): string | null {
  if (!bodyText) return null;
  // Only the top of the message — quoted history below is not the ask
  const top = bodyText.slice(0, 2500).split(/^\s*(?:>|On .+ wrote:)/m)[0];

  let best: { s: string; score: number } | null = null;
  const list = sentences(top).slice(0, 25);

  list.forEach((s, idx) => {
    if (s.length < 8 || s.length > 220) return;
    if (NOISE.test(s)) return;
    let score = 0;
    for (const p of REQUEST_PATTERNS) {
      if (p.re.test(s)) score += p.score;
    }
    if (score === 0) return;
    if (FILLER.test(s)) score -= 4;
    // Earlier sentences carry the ask more often
    score += Math.max(0, 4 - idx * 0.5);
    // A question mark aimed at the reader is the classic shape
    if (/\byou\b/i.test(s) && /\?/.test(s)) score += 4;
    if (!best || score > best.score) best = { s, score };
  });

  if (!best) return null;
  const hit = best as { s: string; score: number };
  if (hit.score < 8) return null;
  return requestCore(hit.s);
}

/**
 * Cut through the pleasantries to the imperative core of the sentence:
 * "Good morning and thank you for reaching out please provide your
 * full name…" → "provide your full name…". The ask is the verb clause,
 * not the greeting wrapped around it.
 */
function requestCore(sentence: string): string {
  let s = sentence.trim();

  // "…can/could/would/will you (please) <do X>" → "<do X>"
  const canYou = s.match(
    /\b(?:can|could|would|will|do) you\s+(?:please\s+)?(.{8,})/i,
  );
  if (canYou) {
    s = canYou[1];
  } else {
    // "…please/kindly <do X>" → "<do X>"
    const please = s.match(/\b(?:please|kindly)\s+(.{8,})/i);
    if (please) s = please[1];
  }

  // Trailing courtesy that adds nothing
  s = s
    .replace(/\s*(as soon as possible|at your earliest convenience|when you (get|have) a (chance|moment|minute)|whenever works|if you can|thanks?( so much| in advance)?)[.!?,]*\s*$/i, "")
    .replace(/^(awesome|great|also|and|so|ok(ay)?)[,\s-]+/i, "")
    .replace(/[.!?,\s]+$/, "")
    .trim();

  return s.length >= 8 ? s : sentence.trim();
}
