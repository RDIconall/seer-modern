/**
 * Keyword intel ported from legacy Seer Intel.scala.
 *
 * Anyone who can deliver mail controls the subject and preview, so a
 * single common word ("now", "send", "confirm", "discuss") must never
 * count as an ask. Requests are matched by shape — a question put to
 * the reader, or an ask verb followed by its object — and the schedule
 * count only covers words that name a real time.
 */

const NOTICES_KEYWORDS =
  "remember,forget,reminder,calling,now,in a few minutes,little late,almost there,one minute,delay,running late,are you joining"
    .split(",")
    .sort();
/** Words that name a time. Topic words (meet, discuss, schedule) are not times. */
const SCHEDULE_KEYWORDS =
  "what time,are you free,today,tonight,tomorrow,next week,monday,tuesday,wednesday,thursday,friday,saturday,sunday,p.m.,a.m.,mon,tue,thu,fri"
    .split(",")
    .sort();

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function createRegex(words: readonly string[]): RegExp {
  const inner = words.map((w) => `(${escapeRegex(w)})`).join("|");
  const body = `((^)|([\\n\\t ]))(${inner})(([\\n\\t "\`)\\]}>;:!.,?])|($))`;
  return new RegExp(body, "gi");
}

const NOTICES_REGEX = createRegex(NOTICES_KEYWORDS);
const SCHEDULE_REGEX = createRegex(SCHEDULE_KEYWORDS);

/** What an ask verb must act on: a pronoun, a determiner + noun, or a clause. */
const OBJECT =
  "(?:me|us|him|her|them|it|this|that|these|those|(?:the|your|our|my|a|an|his|their)\\s+[a-z0-9]|if|whether|when|what|which|who|how|by\\s+[a-z0-9])";

const ASK_VERBS =
  "send|forward|confirm|review|sign|approve|share|call|reply to|respond to|return|complete|check|update|fill out|look at|take a look at|let me know|let us know|get back to me|get back to us";

/** A question put to the reader, kept to one line so subject and preview can't be stitched. */
const REQUEST_SHAPES: readonly RegExp[] = [
  /\b(?:can|could|would|will)\s+you\s+[a-z][^?\n]{0,160}\?/gi,
  /\bare\s+you\s+(?:free|available|around|able\s+to)\b[^?\n]{0,160}\?/gi,
  new RegExp(`\\bplease\\s+(?:${ASK_VERBS})\\s+${OBJECT}`, "gi"),
  new RegExp(
    `\\b(?:let\\s+(?:me|us)\\s+know|get\\s+back\\s+to\\s+(?:me|us))\\s+(?:if|whether|when|what|which|who|how|by\\s+[a-z0-9])`,
    "gi",
  ),
  new RegExp(
    `\\b(?:send|forward)\\s+(?:me|us)\\s+(?:the|your|this|that|these|those|a|an|it|over)\\b`,
    "gi",
  ),
  new RegExp(`\\btake\\s+a\\s+look\\s+at\\s+${OBJECT}`, "gi"),
];

const FOLLOW_UP_SHAPES: readonly RegExp[] = [
  /\b(?:did|have)\s+you\s+(?:get|got|see|seen|receive|received|read|review|reviewed|sign|signed|send|sent|check|checked|hear|heard|(?:had|have|get)\s+a\s+chance)\b[^?\n]{0,160}\?/gi,
  /\bdo\s+you\s+have\s+(?:time|a\s+(?:minute|moment|second)|availability|any\s+(?:time|availability|thoughts|updates?))\b[^?\n]{0,160}\?/gi,
  /\bany\s+updates?\s+on\s+(?:the|your|this|that|our)\s+[a-z0-9][^?\n]{0,160}\?/gi,
];

function contains(text: string, re: RegExp): boolean {
  re.lastIndex = 0;
  return re.test(text);
}

function count(text: string, re: RegExp): number {
  let n = 0;
  const r = new RegExp(re.source, re.flags);
  while (r.exec(text) !== null) n += 1;
  return n;
}

function countShapes(text: string, shapes: readonly RegExp[]): number {
  return shapes.reduce((n, re) => n + count(text, re), 0);
}

/**
 * Any intel signal at all, including notices and time words. This is a
 * topical hint for sentence scoring, not evidence of an ask — graders
 * must use the `request` and `followUp` counts.
 */
export function intelContainsAny(text: string): boolean {
  return (
    contains(text, NOTICES_REGEX) ||
    contains(text, SCHEDULE_REGEX) ||
    countShapes(text, REQUEST_SHAPES) > 0 ||
    countShapes(text, FOLLOW_UP_SHAPES) > 0
  );
}

export type IntelBreakdown = {
  notices: number;
  schedule: number;
  request: number;
  followUp: number;
};

export function intelBreakdown(text: string): IntelBreakdown {
  return {
    notices: count(text, NOTICES_REGEX),
    schedule: count(text, SCHEDULE_REGEX),
    request: countShapes(text, REQUEST_SHAPES),
    followUp: countShapes(text, FOLLOW_UP_SHAPES),
  };
}

export function intelCountAll(text: string): number {
  const b = intelBreakdown(text);
  return b.notices + b.schedule + b.request + b.followUp;
}
