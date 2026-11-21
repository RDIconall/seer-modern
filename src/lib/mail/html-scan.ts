/**
 * Linear-time scanners for the markup shapes mail code strips out of bodies.
 *
 * Each function returns exactly what the regular expression named above it
 * returns, but finds every match in one left-to-right pass. Those expressions
 * restart at every opener ("<", "<div", "[image:") and rescan to the next
 * closer, so a body made of thousands of unclosed openers costs the square of
 * its length — long enough to hold a server worker until it is killed.
 *
 * Runs on the server and in the browser; no DOM, no dependencies.
 */

/** The most HTML any one body-to-text conversion reads. */
export const HTML_SCAN_LIMIT = 500_000;

/** The first `HTML_SCAN_LIMIT` characters of a body: the part converted to text. */
export function capHtml(html: string): string {
  return html.length > HTML_SCAN_LIMIT ? html.slice(0, HTML_SCAN_LIMIT) : html;
}

/**
 * ASCII-only lowercase. Index-aligned with the source, which `toLowerCase`
 * is not, and the same folding a non-unicode `i` flag applies.
 */
export function asciiLower(s: string): string {
  return s.replace(/[A-Z]+/g, (run) => run.toLowerCase());
}

/** Code units JavaScript's `\s` matches. */
export function isRegexSpace(code: number): boolean {
  return (
    (code >= 0x09 && code <= 0x0d) ||
    code === 0x20 ||
    code === 0xa0 ||
    code === 0x1680 ||
    (code >= 0x2000 && code <= 0x200a) ||
    code === 0x2028 ||
    code === 0x2029 ||
    code === 0x202f ||
    code === 0x205f ||
    code === 0x3000 ||
    code === 0xfeff
  );
}

function isAsciiLetter(code: number): boolean {
  return (code >= 65 && code <= 90) || (code >= 97 && code <= 122);
}

function isAsciiAlnum(code: number): boolean {
  return isAsciiLetter(code) || (code >= 48 && code <= 57);
}

/** `\w` without the unicode flag. */
function isWordCode(code: number): boolean {
  return isAsciiAlnum(code) || code === 95;
}

function skipSpace(s: string, i: number): number {
  while (i < s.length && isRegexSpace(s.charCodeAt(i))) i += 1;
  return i;
}

/** End of the `\w` run at `i`, read no further than `cap` characters. */
function wordEnd(s: string, i: number, cap: number): number {
  const stop = Math.min(s.length, i + cap);
  while (i < stop && isWordCode(s.charCodeAt(i))) i += 1;
  return i;
}

function longest(names: ReadonlySet<string>): number {
  let max = 0;
  for (const name of names) max = Math.max(max, name.length);
  return max;
}

/**
 * `indexOf` for callers whose `from` never decreases: each call resumes where
 * the last one found its answer instead of rescanning the same span.
 */
function forwardFinder(haystack: string, needle: string): (from: number) => number {
  let at = -2;
  return (from) => {
    if (at === -1) return -1;
    if (at === -2 || at < from) at = haystack.indexOf(needle, from);
    return at;
  };
}

type Span = { start: number; end: number };

function spliceSpans(
  s: string,
  spans: Iterable<Span & { text: string }>,
): string {
  let out = "";
  let last = 0;
  for (const span of spans) {
    out += s.slice(last, span.start) + span.text;
    last = span.end;
  }
  return last === 0 && out === "" ? s : out + s.slice(last);
}

/**
 * `html.replace(/<[^>]+>/g, replacement)`, or `/<[^>]*>/g` with `allowEmpty`.
 */
export function replaceTags(
  html: string,
  replacement: string,
  allowEmpty = false,
): string {
  function* spans() {
    let open = html.indexOf("<");
    while (open !== -1) {
      const close = html.indexOf(">", open + 1);
      // No ">" after this "<" means none after any later "<" either.
      if (close === -1) return;
      if (close === open + 1 && !allowEmpty) {
        open = html.indexOf("<", close);
        continue;
      }
      yield { start: open, end: close + 1, text: replacement };
      open = html.indexOf("<", close + 1);
    }
  }
  return spliceSpans(html, spans());
}

/** Tags removed from at most `HTML_SCAN_LIMIT` characters of `html`. */
export function stripTags(html: string, replacement = " "): string {
  return replaceTags(capHtml(html), replacement);
}

/** An HTML-only body as one line of text, for grading and drafting. */
export function htmlBodyText(html: string): string {
  return stripTags(html).replace(/\s+/g, " ");
}

/** `s.replace(/OPEN[\s\S]*?CLOSE/g, replacement)` for literal OPEN and CLOSE. */
export function replaceBetween(
  s: string,
  open: string,
  close: string,
  replacement: string,
): string {
  function* spans() {
    let start = s.indexOf(open);
    while (start !== -1) {
      const end = s.indexOf(close, start + open.length);
      if (end === -1) return;
      yield { start, end: end + close.length, text: replacement };
      start = s.indexOf(open, end + close.length);
    }
  }
  return spliceSpans(s, spans());
}

/** `html.replace(/PREFIX[^>]*>/gi, replacement)` for a lowercase literal PREFIX. */
export function replacePrefixedTags(
  html: string,
  prefix: string,
  replacement: string,
): string {
  const lower = asciiLower(html);
  function* spans() {
    let start = lower.indexOf(prefix);
    while (start !== -1) {
      const close = html.indexOf(">", start + prefix.length);
      if (close === -1) return;
      yield { start, end: close + 1, text: replacement };
      start = lower.indexOf(prefix, close + 1);
    }
  }
  return spliceSpans(html, spans());
}

/**
 * `html.replace(/<\/?(NAMES)\b[^>]*>/gi, replacement)`, without the optional
 * slash when `closing` is false. NAMES are lowercase words.
 */
export function replaceNamedTags(
  html: string,
  names: ReadonlySet<string>,
  replacement: string,
  closing: boolean,
): string {
  const lower = asciiLower(html);
  const max = longest(names);
  function* spans() {
    let open = html.indexOf("<");
    while (open !== -1) {
      let p = open + 1;
      if (closing && html.charCodeAt(p) === 47) p += 1;
      const end = wordEnd(html, p, max + 1);
      if (end - p <= max && names.has(lower.slice(p, end))) {
        const close = html.indexOf(">", end);
        if (close === -1) return;
        yield { start: open, end: close + 1, text: replacement };
        open = html.indexOf("<", close + 1);
        continue;
      }
      open = html.indexOf("<", open + 1);
    }
  }
  return spliceSpans(html, spans());
}

/**
 * `html.replace(/<(NAMES)\b[^>]*>[\s\S]*?<\/\1>/gi, replacement)` — an element
 * and everything inside it. With `spaceBeforeGt` the closing tag is
 * `<\/\1\s*>`. NAMES are lowercase words.
 */
export function removeElements(
  html: string,
  names: ReadonlySet<string>,
  replacement: string,
  spaceBeforeGt: boolean,
): string {
  const lower = asciiLower(html);
  const max = longest(names);
  const nextGt = forwardFinder(html, ">");
  const closers = new Map<string, (from: number) => number>();

  /** End of the first `</name\s*>` at or after `from`, or -1. */
  function closerFor(name: string): (from: number) => number {
    const needle = `</${name}`;
    let at = -2;
    let atEnd = -1;
    return (from) => {
      if (at === -1) return -1;
      if (at !== -2 && at >= from) return atEnd;
      let j = lower.indexOf(needle, from);
      while (j !== -1) {
        let k = j + needle.length;
        if (spaceBeforeGt) k = skipSpace(lower, k);
        if (lower.charCodeAt(k) === 62) {
          at = j;
          atEnd = k + 1;
          return atEnd;
        }
        j = lower.indexOf(needle, k);
      }
      at = -1;
      return -1;
    };
  }

  function* spans() {
    let open = html.indexOf("<");
    while (open !== -1) {
      const p = open + 1;
      const end = wordEnd(html, p, max + 1);
      const name = end - p <= max ? lower.slice(p, end) : "";
      if (names.has(name)) {
        const gt = nextGt(end);
        if (gt === -1) return;
        let closer = closers.get(name);
        if (!closer) {
          closer = closerFor(name);
          closers.set(name, closer);
        }
        const stop = closer(gt + 1);
        if (stop !== -1) {
          yield { start: open, end: stop, text: replacement };
          open = html.indexOf("<", stop);
          continue;
        }
      }
      open = html.indexOf("<", open + 1);
    }
  }
  return spliceSpans(html, spans());
}

/**
 * `html.replace(/<(\/?)([a-zA-Z][a-zA-Z0-9]*)\b([^>]*?)(\/?)>/g, render)`.
 */
export function rewriteTags(
  html: string,
  render: (close: boolean, name: string, attrs: string, selfClose: boolean) => string,
): string {
  function* spans() {
    let open = html.indexOf("<");
    while (open !== -1) {
      let p = open + 1;
      const close = html.charCodeAt(p) === 47;
      if (close) p += 1;
      if (isAsciiLetter(html.charCodeAt(p))) {
        let end = p + 1;
        while (end < html.length && isAsciiAlnum(html.charCodeAt(end))) end += 1;
        // `\b`: an alphanumeric run followed by "_" has no boundary at all.
        if (html.charCodeAt(end) !== 95) {
          const gt = html.indexOf(">", end);
          if (gt === -1) return;
          const selfClose = gt > end && html.charCodeAt(gt - 1) === 47;
          yield {
            start: open,
            end: gt + 1,
            text: render(
              close,
              html.slice(p, end),
              html.slice(end, selfClose ? gt - 1 : gt),
              selfClose,
            ),
          };
          open = html.indexOf("<", gt + 1);
          continue;
        }
      }
      open = html.indexOf("<", open + 1);
    }
  }
  return spliceSpans(html, spans());
}

/** End of a `<br\s*\/>` (any case) at `i`, or -1. */
function breakEnd(html: string, i: number): number {
  if (html.charCodeAt(i) !== 60) return -1;
  const b = html.charCodeAt(i + 1);
  const r = html.charCodeAt(i + 2);
  if ((b !== 98 && b !== 66) || (r !== 114 && r !== 82)) return -1;
  const k = skipSpace(html, i + 3);
  return html.charCodeAt(k) === 47 && html.charCodeAt(k + 1) === 62 ? k + 2 : -1;
}

/** `html.replace(/(\s*<br\s*\/>\s*){3,}/gi, replacement)`. */
export function collapseBreaks(html: string, replacement: string): string {
  function* spans() {
    let last = 0;
    let open = html.indexOf("<");
    while (open !== -1) {
      let end = breakEnd(html, open);
      if (end === -1) {
        open = html.indexOf("<", open + 1);
        continue;
      }
      let count = 1;
      let after = skipSpace(html, end);
      for (let next = breakEnd(html, after); next !== -1; next = breakEnd(html, after)) {
        count += 1;
        end = next;
        after = skipSpace(html, end);
      }
      if (count >= 3) {
        let start = open;
        while (start > last && isRegexSpace(html.charCodeAt(start - 1))) start -= 1;
        yield { start, end: after, text: replacement };
        last = after;
      }
      open = html.indexOf("<", after);
    }
  }
  return spliceSpans(html, spans());
}

/**
 * Every match of `/PREFIX[^>]*INNER/gi`, as `match` with the `g` flag would
 * find them. PREFIX is a lowercase literal without ">"; `inner` is a global,
 * case-insensitive expression whose matches cannot start inside one another.
 */
export function prefixedTagMatches(
  html: string,
  lower: string,
  prefix: string,
  inner: RegExp,
): Span[] {
  const inners: Span[] = [];
  inner.lastIndex = 0;
  for (let m = inner.exec(html); m; m = inner.exec(html)) {
    inners.push({ start: m.index, end: m.index + m[0].length });
    if (m[0].length === 0) inner.lastIndex += 1;
  }
  const out: Span[] = [];
  let k = 0;
  let open = lower.indexOf(prefix);
  while (open !== -1) {
    const from = open + prefix.length;
    const gt = html.indexOf(">", from);
    const stop = gt === -1 ? html.length : gt;
    while (k < inners.length && inners[k].start < from) k += 1;
    // `[^>]*` is greedy: the match ends at the LAST inner match that starts
    // before the ">". Any later PREFIX before that ">" can only see a subset
    // of the same inner matches, so none of them matches either way.
    let best = -1;
    while (k < inners.length && inners[k].start < stop) {
      best = k;
      k += 1;
    }
    if (best !== -1) out.push({ start: open, end: inners[best].end });
    if (gt === -1) break;
    const resume = best === -1 ? gt : Math.max(gt, inners[best].end);
    open = lower.indexOf(prefix, resume);
  }
  return out;
}

const DIVIDER_TAIL = /\s*Original Message\s*-{2,}/iy;

/** Every match of `/-{2,}\s*Original Message\s*-{2,}/gi`. */
export function dividerMatches(s: string): Span[] {
  const out: Span[] = [];
  let i = s.indexOf("--");
  while (i !== -1) {
    let run = i + 2;
    while (s.charCodeAt(run) === 45) run += 1;
    DIVIDER_TAIL.lastIndex = run;
    if (DIVIDER_TAIL.test(s)) {
      out.push({ start: i, end: DIVIDER_TAIL.lastIndex });
      i = s.indexOf("--", DIVIDER_TAIL.lastIndex);
    } else {
      // Every later start inside this run of dashes reaches the same tail.
      i = s.indexOf("--", run);
    }
  }
  return out;
}

export type ParsedAttribute = { name: string; value: string };

/**
 * Every match of
 * `/([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*("([^"]*)"|'([^']*)'|([^\s"'>]+))/g`,
 * with the value from whichever of the three groups matched.
 */
export function parseAttributes(raw: string): ParsedAttribute[] {
  const out: ParsedAttribute[] = [];
  const nextDouble = forwardFinder(raw, '"');
  const nextSingle = forwardFinder(raw, "'");
  const isNameStart = (c: number) => isAsciiLetter(c) || c === 95 || c === 58;
  const isNameChar = (c: number) =>
    isAsciiAlnum(c) || c === 95 || c === 58 || c === 45 || c === 46;
  let i = 0;
  while (i < raw.length) {
    if (!isNameStart(raw.charCodeAt(i))) {
      i += 1;
      continue;
    }
    const start = i;
    let end = i + 1;
    while (end < raw.length && isNameChar(raw.charCodeAt(end))) end += 1;
    // A start inside this name has the same end and the same failure, so a
    // failed match resumes at `end`.
    i = end;
    let k = skipSpace(raw, end);
    if (raw.charCodeAt(k) !== 61) continue;
    k = skipSpace(raw, k + 1);
    const quote = raw.charCodeAt(k);
    let value: string | null = null;
    let stop = k;
    if (quote === 34 || quote === 39) {
      const close = (quote === 34 ? nextDouble : nextSingle)(k + 1);
      if (close !== -1) {
        value = raw.slice(k + 1, close);
        stop = close + 1;
      }
    } else {
      while (stop < raw.length) {
        const c = raw.charCodeAt(stop);
        if (c === 34 || c === 39 || c === 62 || isRegexSpace(c)) break;
        stop += 1;
      }
      if (stop > k) value = raw.slice(k, stop);
    }
    if (value === null) continue;
    out.push({ name: raw.slice(start, end), value });
    i = stop;
  }
  return out;
}

const HREF_AT = /href=["'](https?:\/\/[^"']+)["']/iy;

/**
 * Every match of
 * `/<a\b[^>]*href=["'](https?:\/\/[^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi`,
 * as `{ url, text }` for groups 1 and 2, in order.
 */
export function* anchorLinks(html: string): Generator<{ url: string; text: string }> {
  const lower = asciiLower(html);
  const lastClose = lower.lastIndexOf("</a>");
  const nextHref = forwardFinder(lower, "href=");
  let open = lower.indexOf("<a");
  while (open !== -1) {
    if (isWordCode(html.charCodeAt(open + 2))) {
      open = lower.indexOf("<a", open + 1);
      continue;
    }
    const from = open + 2;
    const gt = html.indexOf(">", from);
    if (gt === -1) return;
    // `[^>]*` is greedy, so the href that counts is the last one before the
    // ">" whose link, closing ">" and "</a>" all follow. Only that last href's
    // URL can run past this ">"; every earlier one ends at the next href's
    // quote, so the closing ">" for each of those is this one.
    let last: { end: number; url: string } | null = null;
    let earlier: { end: number; url: string } | null = null;
    for (let s = nextHref(from); s !== -1 && s < gt; s = nextHref(s + 1)) {
      HREF_AT.lastIndex = s;
      const m = HREF_AT.exec(html);
      if (!m) continue;
      earlier = last;
      last = { end: HREF_AT.lastIndex, url: m[1] };
    }
    let chosen: { url: string; tagEnd: number } | null = null;
    if (last) {
      const tagEnd = last.end <= gt ? gt : html.indexOf(">", last.end);
      if (tagEnd !== -1 && lastClose > tagEnd) chosen = { url: last.url, tagEnd };
      else if (earlier && lastClose > gt) chosen = { url: earlier.url, tagEnd: gt };
    }
    if (!chosen) {
      // A later "<a" before this ">" sees a subset of the same hrefs.
      open = lower.indexOf("<a", gt);
      continue;
    }
    const close = lower.indexOf("</a>", chosen.tagEnd + 1);
    yield { url: chosen.url, text: html.slice(chosen.tagEnd + 1, close) };
    open = lower.indexOf("<a", close + 4);
  }
}

/**
 * Remove the html-to-text residue the models should not read:
 * `.replace(/\[image:[^\]]*\]/gi, " ").replace(/<https?:\/\/[^>\s]+>/g, " ")
 * .replace(/\s+/g, " ")`.
 */
export function stripTextResidue(text: string): string {
  const lower = asciiLower(text);
  function* images() {
    let start = lower.indexOf("[image:");
    while (start !== -1) {
      const close = text.indexOf("]", start + 7);
      if (close === -1) return;
      yield { start, end: close + 1, text: " " };
      start = lower.indexOf("[image:", close + 1);
    }
  }
  const noImages = spliceSpans(text, images());
  function* refs() {
    let open = noImages.indexOf("<http");
    while (open !== -1) {
      let p = open + 5;
      if (noImages.charCodeAt(p) === 115) p += 1;
      if (!noImages.startsWith("://", p)) {
        open = noImages.indexOf("<http", open + 1);
        continue;
      }
      let end = p + 3;
      while (end < noImages.length) {
        const c = noImages.charCodeAt(end);
        if (c === 62 || isRegexSpace(c)) break;
        end += 1;
      }
      if (end > p + 3 && noImages.charCodeAt(end) === 62) {
        yield { start: open, end: end + 1, text: " " };
        open = noImages.indexOf("<http", end + 1);
        continue;
      }
      // Every later "<http" inside this run stops at the same character.
      open = noImages.indexOf("<http", end);
    }
  }
  return spliceSpans(noImages, refs()).replace(/\s+/g, " ");
}
