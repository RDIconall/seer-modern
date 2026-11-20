/**
 * Tag-level passes over mail HTML, in one pass each.
 *
 * `html.replace(/<[^>]+>/g, " ")` restarts at every "<" and runs to the end of
 * the string looking for a ">" the sender never wrote, so a body made of N
 * less-than signs costs N² steps. Every pattern of the shape `<x[^>]*…` or
 * `<x…[\s\S]*?</x>` has the same cost when the sender leaves out what it is
 * looking for. Whoever sends the message writes the body.
 */

/** HTML beyond this length is cut before it is turned into text. */
export const HTML_TEXT_SCAN_LIMIT = 200_000;

export type TagScan = {
  /**
   * Index of the first match of `pattern` (which must carry the `g` flag) at
   * or after `from`, or -1. Calls for one pattern must not move `from`
   * backwards; that is what lets a miss, or a match not yet passed, answer
   * every later call without rescanning.
   */
  find(pattern: RegExp, from: number): { index: number; length: number } | null;
};

/** A tag's replacement, optionally resuming past `resume` instead of the tag. */
export type TagResult = string | { text: string; resume: number };

function createScan(html: string): TagScan {
  const memo = new Map<RegExp, { from: number; hit: { index: number; length: number } | null }>();
  return {
    find(pattern, from) {
      const last = memo.get(pattern);
      if (last && from >= last.from && (!last.hit || from <= last.hit.index)) {
        return last.hit;
      }
      pattern.lastIndex = from;
      const match = pattern.exec(html);
      const hit = match ? { index: match.index, length: match[0].length } : null;
      memo.set(pattern, { from, hit });
      return hit;
    },
  };
}

/**
 * Walk `html` once with the same idea of a tag as `/<[^>]+>/`: from a "<" to
 * the first ">" after it, with at least one character between. Text between
 * tags is copied; each tag is replaced by what `onTag` returns.
 */
export function rewriteTags(
  html: string,
  onTag: (tag: string, start: number, scan: TagScan) => TagResult,
): string {
  const scan = createScan(html);
  const parts: string[] = [];
  let copied = 0;
  let open = html.indexOf("<");
  while (open !== -1) {
    const close = html.indexOf(">", open + 1);
    // No ">" after this "<" means none after any later "<" either.
    if (close === -1) break;
    if (close === open + 1) {
      open = html.indexOf("<", close);
      continue;
    }
    const result = onTag(html.slice(open, close + 1), open, scan);
    parts.push(html.slice(copied, open));
    if (typeof result === "string") {
      parts.push(result);
      copied = close + 1;
    } else {
      parts.push(result.text);
      copied = Math.max(close + 1, result.resume);
    }
    open = html.indexOf("<", copied);
  }
  parts.push(html.slice(copied));
  return parts.join("");
}

/** The same output as `html.replace(/<[^>]+>/g, replacement)`, in linear time. */
export function stripTags(html: string, replacement = " "): string {
  return rewriteTags(html, () => replacement);
}

/** A flat, single-spaced text rendering of an HTML part, capped before the scan. */
export function htmlBodyText(html: string): string {
  return stripTags(html.slice(0, HTML_TEXT_SCAN_LIMIT)).replace(/\s+/g, " ");
}

/**
 * Escape every "<" that cannot open a tag: one with no ">" after it, or one
 * inside a tag that is already open (`<a title="x<y">`). Afterwards each "<"
 * reaches its own ">" without passing another "<", so a pattern such as
 * `<div[^>]*id=` started at any "<" stops at that tag's end, and the scans
 * from all the "<" together cover the string once.
 */
export function escapeStrayTagOpeners(html: string): string {
  const parts: string[] = [];
  let copied = 0;
  let open = html.indexOf("<");
  while (open !== -1) {
    const close = html.indexOf(">", open + 1);
    if (close === -1) {
      parts.push(html.slice(copied).replaceAll("<", "&lt;"));
      return parts.join("");
    }
    parts.push(html.slice(copied, open + 1), html.slice(open + 1, close + 1).replaceAll("<", "&lt;"));
    copied = close + 1;
    open = html.indexOf("<", copied);
  }
  parts.push(html.slice(copied));
  return parts.join("");
}
