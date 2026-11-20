/**
 * Linear-time passes over untrusted HTML.
 *
 * Mail bodies are attacker-controlled and have no size limit. A global regex
 * such as `/<[^>]+>/g` restarts its scan at every "<" and, when no ">" follows,
 * walks to the end of the string each time: a body made of "<" is quadratic and
 * freezes whoever processes it. Every helper here does the same job as the
 * regex it replaces, but never looks at a character more than a fixed number of
 * times.
 */

/** Every `<…>` span replaced, exactly as `html.replace(/<[^>]+>/g, replacement)`. */
export function stripTags(html: string, replacement = " "): string {
  let out = "";
  let copied = 0;
  let from = 0;
  for (;;) {
    const open = html.indexOf("<", from);
    if (open === -1) break;
    const close = html.indexOf(">", open + 1);
    // No ">" anywhere after this "<" means none after any later "<" either.
    if (close === -1) break;
    if (close === open + 1) {
      from = close;
      continue;
    }
    out += html.slice(copied, open) + replacement;
    copied = from = close + 1;
  }
  return copied === 0 ? html : out + html.slice(copied);
}

/**
 * Every span from `open` to the nearest following `close` replaced, exactly as
 * a global `open[\s\S]*?close` regex would. An `open` with no `close` after it
 * is left as it is.
 */
export function removeDelimited(
  html: string,
  open: string,
  close: string,
  replacement = "",
): string {
  let out = "";
  let copied = 0;
  for (;;) {
    const start = html.indexOf(open, copied);
    if (start === -1) break;
    const stop = html.indexOf(close, start + open.length);
    if (stop === -1) break;
    out += html.slice(copied, start) + replacement;
    copied = stop + close.length;
  }
  return copied === 0 ? html : out + html.slice(copied);
}

/**
 * `html.replace(pattern, replacer)` for a global pattern whose every match
 * ends in ">" and that cannot step past a ">" before it (`<tag\b[^>]*>` and the
 * like). Such a pattern can only match before the last ">", and past it every
 * attempt would scan to the end of the string, so the tail is never searched.
 */
export function replaceTerminated(
  html: string,
  pattern: RegExp,
  replacer: string | ((substring: string, ...args: string[]) => string),
): string {
  const end = html.lastIndexOf(">") + 1;
  if (end === 0) return html;
  const head = html.slice(0, end);
  const replaced =
    typeof replacer === "string" ? head.replace(pattern, replacer) : head.replace(pattern, replacer);
  return replaced + html.slice(end);
}

/**
 * Each named element removed together with its content, exactly as a global
 * `<(a|b)\b[^>]*>[\s\S]*?<\/\1\s*>` (case-insensitive) would. An opening tag
 * with no closing tag after it is left as it is.
 */
export function removeElements(
  html: string,
  names: readonly string[],
  replacement = " ",
): string {
  const end = html.lastIndexOf(">") + 1;
  if (end === 0) return html;
  const head = html.slice(0, end);
  const opener = new RegExp(`<(${names.join("|")})\\b[^>]*>`, "gi");
  // Per element name, the first closing tag at or after `searchedFrom`. Openers
  // are visited left to right, so each name's search only ever moves forward.
  const closers = new Map<string, { searchedFrom: number; at: number; end: number }>();
  const closingTag = (name: string, from: number) => {
    const cached = closers.get(name);
    if (cached && cached.searchedFrom <= from && (cached.at === -1 || cached.at >= from)) {
      return cached;
    }
    const closer = new RegExp(`<\\/${name}\\s*>`, "gi");
    closer.lastIndex = from;
    const found = closer.exec(html);
    const result = found
      ? { searchedFrom: from, at: found.index, end: found.index + found[0].length }
      : { searchedFrom: from, at: -1, end: -1 };
    closers.set(name, result);
    return result;
  };

  let out = "";
  let copied = 0;
  let match: RegExpExecArray | null;
  while ((match = opener.exec(head)) !== null) {
    const close = closingTag(match[1].toLowerCase(), match.index + match[0].length);
    if (close.at === -1) {
      opener.lastIndex = match.index + 1;
      continue;
    }
    out += html.slice(copied, match.index) + replacement;
    copied = close.end;
    opener.lastIndex = close.end;
  }
  return copied === 0 ? html : out + html.slice(copied);
}
