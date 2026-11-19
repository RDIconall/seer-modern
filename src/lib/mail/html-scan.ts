/**
 * Linear-time scans over untrusted email HTML.
 *
 * Patterns such as `/<[^>]+>/g` retry from every `<` and rescan to the end of
 * the string whenever no `>` follows, so a body that is a long run of `<` (or
 * of `<a`, `<div`, `<!--`, `<style>` …) costs quadratic time and holds the
 * request. Every helper here finds each closer once and never rescans, while
 * matching what the regex it replaces would have matched.
 */

/**
 * `indexOf` for a needle searched at non-decreasing offsets. A hit that is
 * still ahead, or a miss, is remembered instead of being searched for again.
 */
export function forwardFinder(
  haystack: string,
  needle: string,
): (from: number) => number {
  let found = -2;
  return (from) => {
    if (found === -1 || found >= from) return found;
    found = haystack.indexOf(needle, from);
    return found;
  };
}

/** `forwardFinder` for a closer that needs a pattern (case, whitespace). */
export function forwardMatcher(
  haystack: string,
  pattern: RegExp,
): (from: number) => RegExpExecArray | null {
  const re = new RegExp(pattern.source, pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`);
  let found: RegExpExecArray | null | undefined;
  return (from) => {
    if (found === null || (found && found.index >= from)) return found;
    re.lastIndex = from;
    found = re.exec(haystack);
    return found;
  };
}

/**
 * The next `<…>` span at or after `from` — exactly what `/<[^>]+>/` would
 * match there — as `[start, end)` with `end` just past the `>`. Null once no
 * `>` is left, because then nothing further can close.
 */
export function nextTagSpan(
  html: string,
  from: number,
): { start: number; end: number } | null {
  let at = from;
  for (;;) {
    const lt = html.indexOf("<", at);
    if (lt === -1) return null;
    const gt = html.indexOf(">", lt + 1);
    if (gt === -1) return null;
    if (gt > lt + 1) return { start: lt, end: gt + 1 };
    at = lt + 1;
  }
}

/** Replace every `<…>` span; `rewrite` receives the span, brackets included. */
export function replaceTagSpans(
  html: string,
  rewrite: (span: string) => string,
): string {
  let out = "";
  let at = 0;
  let span: { start: number; end: number } | null;
  while ((span = nextTagSpan(html, at)) !== null) {
    out += html.slice(at, span.start) + rewrite(html.slice(span.start, span.end));
    at = span.end;
  }
  return out + html.slice(at);
}

/** `html.replace(/<[^>]+>/g, replacement)` without the quadratic retry. */
export function stripTags(html: string, replacement = " "): string {
  return replaceTagSpans(html, () => replacement);
}

/**
 * `html.replace(/<NAME\b[^>]*>/gi, replacement)` for the opener `opener`
 * (which must not match `>`): within each `<…>` span the first opener runs to
 * that span's `>`.
 */
export function replaceOpeningTags(
  html: string,
  opener: RegExp,
  replacement: string | ((match: RegExpExecArray, rest: string) => string),
): string {
  const re = new RegExp(opener.source, opener.flags.replace(/[gy]/g, ""));
  return replaceTagSpans(html, (span) => {
    const match = re.exec(span);
    if (!match) return span;
    const rest = span.slice(match.index + match[0].length, -1);
    const value = typeof replacement === "string" ? replacement : replacement(match, rest);
    return span.slice(0, match.index) + value;
  });
}

/**
 * `html.replace(/OPEN[\s\S]*?CLOSE/g, replacement)` where `opener` is a
 * literal-like pattern and `closer` a plain string.
 */
export function replaceDelimited(
  html: string,
  opener: RegExp,
  closer: string,
  replacement: string,
): string {
  const open = new RegExp(opener.source, opener.flags.includes("g") ? opener.flags : `${opener.flags}g`);
  const closeAt = forwardFinder(html, closer);
  let out = "";
  let at = 0;
  for (;;) {
    open.lastIndex = at;
    const match = open.exec(html);
    if (!match) break;
    const close = closeAt(match.index + match[0].length);
    if (close === -1) break;
    out += html.slice(at, match.index) + replacement;
    at = close + closer.length;
  }
  return out + html.slice(at);
}

/**
 * `html.replace(/<(NAMES)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, replacement)`: drop an
 * element together with its content. `opener` captures the element name in
 * group 1; `closerSpace` allows whitespace before the closing `>`.
 */
export function replaceElementsWithContent(
  html: string,
  opener: RegExp,
  replacement: string,
  closerSpace: boolean,
): string {
  const open = new RegExp(opener.source, opener.flags.includes("g") ? opener.flags : `${opener.flags}g`);
  const gtAt = forwardFinder(html, ">");
  const closers = new Map<string, (from: number) => RegExpExecArray | null>();
  let out = "";
  let at = 0;
  let searchFrom = 0;
  for (;;) {
    open.lastIndex = searchFrom;
    const match = open.exec(html);
    if (!match) break;
    const gt = gtAt(match.index + match[0].length);
    if (gt === -1) break;
    const name = match[1].toLowerCase();
    let closeAt = closers.get(name);
    if (!closeAt) {
      closeAt = forwardMatcher(
        html,
        new RegExp(`</${name.replace(/[^a-z0-9]/g, "")}${closerSpace ? "\\s*" : ""}>`, "i"),
      );
      closers.set(name, closeAt);
    }
    const close = closeAt(gt + 1);
    if (!close) {
      searchFrom = match.index + 1;
      continue;
    }
    out += html.slice(at, match.index) + replacement;
    at = searchFrom = close.index + close[0].length;
  }
  return out + html.slice(at);
}
