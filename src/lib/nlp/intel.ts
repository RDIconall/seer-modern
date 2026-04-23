/**
 * Keyword intel ported from legacy Seer Intel.scala.
 */

const NOTICES_KEYWORDS =
  "remember,forget,reminder,calling,now,in a few minutes,little late,almost there,one minute,delay,running late,are you joining"
    .split(",")
    .sort();
const SCHEDULE_KEYWORDS =
  "what time,meet,schedule,meeting,conference,discuss,appointment,are you free,today,tomorrow,next week,monday,tuesday,wednesday,thursday,friday,saturday,sunday,p.m.,a.m.,mon,tue,wed,thu,fri,sat,sun"
    .split(",")
    .sort();
const REQUEST_KEYWORDS =
  "requests,can you,forward me,could you,did you,do you,will you,call me,take a look,let me know,send,please let,confirm,thanks in advance,would you"
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
const REQUEST_REGEX = createRegex(REQUEST_KEYWORDS);
const FOLLOW_UP_REGEX = createRegex(REQUEST_KEYWORDS);

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

export function intelContainsAny(text: string): boolean {
  return (
    contains(text, NOTICES_REGEX) ||
    contains(text, SCHEDULE_REGEX) ||
    contains(text, REQUEST_REGEX) ||
    contains(text, FOLLOW_UP_REGEX)
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
    request: count(text, REQUEST_REGEX),
    followUp: count(text, FOLLOW_UP_REGEX),
  };
}

export function intelCountAll(text: string): number {
  const b = intelBreakdown(text);
  return b.notices + b.schedule + b.request + b.followUp;
}
