/**
 * Tag scanning over mail HTML in linear time.
 *
 * Mail bodies are written by whoever sends the mail. Patterns such as
 * `/<[^>]+>/g` rescan the rest of the string from every `<` that is not
 * closed, so a body that is nothing but `<` costs seconds per message. Each
 * helper here gives the same result as the regex it names, but finds every
 * delimiter at most once.
 */

/**
 * Longest HTML body the plain-text callers strip. Model prompts read a few
 * thousand characters; the rest of a larger body is never looked at.
 */
export const MAX_HTML_SCAN_CHARS = 200_000;

/**
 * `html.replace(/<HEAD[^>]*>/g, replace)`, where `head` is a sticky (`y`)
 * pattern that cannot match `>`. `rest` is the text between the head and `>`.
 */
export function replaceTags(
  html: string,
  head: RegExp,
  replace: (match: RegExpExecArray, rest: string) => string,
): string {
  const out: string[] = [];
  let emitted = 0;
  let from = 0;
  let gt = -1;
  for (;;) {
    const lt = html.indexOf("<", from);
    if (lt === -1) break;
    if (gt < lt) {
      gt = html.indexOf(">", lt + 1);
      if (gt === -1) break;
    }
    head.lastIndex = lt + 1;
    const match = head.exec(html);
    if (!match || head.lastIndex > gt) {
      from = lt + 1;
      continue;
    }
    out.push(html.slice(emitted, lt), replace(match, html.slice(head.lastIndex, gt)));
    emitted = from = gt + 1;
  }
  out.push(html.slice(emitted));
  return out.join("");
}

const ANY_TAG_HEAD = /(?!>)/y;

/** `html.replace(/<[^>]+>/g, replacement)`. */
export function stripTags(html: string, replacement = " "): string {
  return replaceTags(html, ANY_TAG_HEAD, () => replacement);
}

/** `html.replace(/OPEN[\s\S]*?CLOSE/g, replacement)` for literal delimiters. */
export function replaceDelimited(
  html: string,
  open: string,
  close: string,
  replacement: string,
): string {
  const out: string[] = [];
  let emitted = 0;
  for (;;) {
    const start = html.indexOf(open, emitted);
    if (start === -1) break;
    const end = html.indexOf(close, start + open.length);
    // No later opener can find a closer either.
    if (end === -1) break;
    out.push(html.slice(emitted, start), replacement);
    emitted = end + close.length;
  }
  out.push(html.slice(emitted));
  return out.join("");
}

/**
 * `html.replace(/<(NAMES)\b[^>]*>[\s\S]*?<\/\1CLOSE_TAIL>/gi, replacement)`:
 * an element and everything inside it. `open` is a global, case-insensitive
 * pattern starting with `<` whose first group is the element name.
 * `closeTail` is the pattern source between the closing name and its `>`.
 */
export function removeElements(
  html: string,
  open: RegExp,
  closeTail: string,
  replacement: string,
): string {
  const out: string[] = [];
  const unclosed = new Set<string>();
  const closers = new Map<string, RegExp>();
  let emitted = 0;
  let from = 0;
  let gt = -1;
  for (;;) {
    open.lastIndex = from;
    const match = open.exec(html);
    if (!match) break;
    const start = match.index;
    if (gt < start) {
      gt = html.indexOf(">", start + 1);
      if (gt === -1) break;
    }
    const name = match[1].toLowerCase();
    if (!unclosed.has(name)) {
      let closer = closers.get(name);
      if (!closer) {
        closer = new RegExp(`</${name}${closeTail}>`, "gi");
        closers.set(name, closer);
      }
      closer.lastIndex = gt + 1;
      const end = closer.exec(html);
      if (end) {
        out.push(html.slice(emitted, start), replacement);
        emitted = from = end.index + end[0].length;
        continue;
      }
      // Nothing after this point closes it, so no later opener of it can.
      unclosed.add(name);
    }
    from = start + 1;
  }
  out.push(html.slice(emitted));
  return out.join("");
}

/**
 * Plain text from an HTML body for model prompts and quoting: capped first,
 * then tags and runs of whitespace collapsed to single spaces.
 */
export function htmlToPlain(html: string, maxChars = MAX_HTML_SCAN_CHARS): string {
  const capped = html.length > maxChars ? html.slice(0, maxChars) : html;
  return stripTags(capped).replace(/\s+/g, " ");
}
