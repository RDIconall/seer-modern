/**
 * Tag-level HTML scanning in time linear in the input.
 *
 * Mail bodies are attacker-controlled. The obvious expressions —
 * `/<[^>]+>/`, `/<div[^>]*…/`, `/<style\b[^>]*>[\s\S]*?<\/style>/` — restart at
 * every "<" and rescan to the next ">" (or the closing tag, or the end of the
 * body) from there, so a body that is one long run of "<" costs time
 * quadratic in its length. These helpers give the same matches, but each
 * search for a ">" or a closing tag is remembered and never repeated over the
 * same stretch of text.
 */

/** Remembers the next match of `pattern` so increasing queries scan each character once. */
function forwardSearch(haystack: string, pattern: RegExp) {
  const re = new RegExp(pattern.source, pattern.flags.replace(/[gy]/g, "") + "g");
  let from = -1;
  let found: { index: number; end: number } | null = null;
  return (position: number): { index: number; end: number } | null => {
    if (from !== -1 && position >= from && (found === null || found.index >= position)) {
      return found;
    }
    re.lastIndex = position;
    const m = re.exec(haystack);
    from = position;
    found = m ? { index: m.index, end: m.index + m[0].length } : null;
    return found;
  };
}

function sticky(prefix: RegExp): RegExp {
  return new RegExp(prefix.source, prefix.flags.replace(/[gy]/g, "") + "y");
}

/**
 * `html.replace(/<PREFIX[^>]*>/g, …)` for a prefix that starts with "<" and
 * cannot match ">". `inner` is the text between the prefix and the ">".
 */
export function replaceTags(
  html: string,
  prefix: RegExp,
  replace: (match: RegExpExecArray, inner: string) => string,
): string {
  const opener = sticky(prefix);
  let out = "";
  let copied = 0;
  let gt = -1;
  let lt = html.indexOf("<");
  while (lt !== -1) {
    opener.lastIndex = lt;
    const m = opener.exec(html);
    if (!m) {
      lt = html.indexOf("<", lt + 1);
      continue;
    }
    const innerStart = lt + m[0].length;
    if (gt < innerStart) gt = html.indexOf(">", innerStart);
    if (gt === -1) break;
    out += html.slice(copied, lt) + replace(m, html.slice(innerStart, gt));
    copied = gt + 1;
    lt = html.indexOf("<", copied);
  }
  return copied === 0 ? html : out + html.slice(copied);
}

/**
 * `html.replace(/<[^>]+>/g, replacement)`, or `/<[^>]*>/g` with `empty`.
 */
export function stripTags(
  html: string,
  replacement = " ",
  { empty = false }: { empty?: boolean } = {},
): string {
  return replaceTags(html, empty ? /</ : /<[^>]/, () => replacement);
}

/** Tag-free text with whitespace runs collapsed to one space. */
export function flattenHtml(html: string): string {
  return stripTags(html).replace(/\s+/g, " ");
}

/**
 * `html.replace(/<(a|b)\b[^>]*>[\s\S]*?<\/\1>/gi, replacement)`: drops each
 * named element together with its content. `spaceBeforeClose` allows
 * `</a  >` as the closing tag.
 */
export function removeElements(
  html: string,
  names: readonly string[],
  replacement: string,
  { spaceBeforeClose = false }: { spaceBeforeClose?: boolean } = {},
): string {
  const opener = new RegExp(`<(${names.join("|")})\\b`, "iy");
  const closers = new Map<string, ReturnType<typeof forwardSearch>>();
  const closerFor = (name: string) => {
    let search = closers.get(name);
    if (!search) {
      search = forwardSearch(html, new RegExp(`</${name}${spaceBeforeClose ? "\\s*" : ""}>`, "i"));
      closers.set(name, search);
    }
    return search;
  };
  let out = "";
  let copied = 0;
  let gt = -1;
  let lt = html.indexOf("<");
  while (lt !== -1) {
    opener.lastIndex = lt;
    const m = opener.exec(html);
    if (m) {
      const innerStart = lt + m[0].length;
      if (gt < innerStart) gt = html.indexOf(">", innerStart);
      if (gt === -1) break;
      const close = closerFor(m[1].toLowerCase())(gt + 1);
      if (close) {
        out += html.slice(copied, lt) + replacement;
        copied = close.end;
        lt = html.indexOf("<", copied);
        continue;
      }
    }
    lt = html.indexOf("<", lt + 1);
  }
  return copied === 0 ? html : out + html.slice(copied);
}

/** `html.replace(/OPEN[\s\S]*?CLOSE/g, replacement)` for literal delimiters. */
export function removeBetween(
  html: string,
  open: string,
  close: string,
  replacement: string,
): string {
  let out = "";
  let copied = 0;
  let start = html.indexOf(open);
  while (start !== -1) {
    const end = html.indexOf(close, start + open.length);
    if (end === -1) break;
    out += html.slice(copied, start) + replacement;
    copied = end + close.length;
    start = html.indexOf(open, copied);
  }
  return copied === 0 ? html : out + html.slice(copied);
}

/**
 * Offsets of every `<name` whose attribute text — up to the next ">", or the
 * end of the body — matches `attributes`, as `/<name[^>]*ATTRIBUTES/gi`
 * would find them. `attributes` must not need to match ">".
 */
export function tagsWithAttributes(
  html: string,
  name: string,
  attributes: RegExp,
): number[] {
  const opener = new RegExp(`<${name}`, "gi");
  const inside = new RegExp(attributes.source, attributes.flags.replace(/[gy]/g, ""));
  const nextGt = forwardSearch(html, />/);
  const found: number[] = [];
  let m: RegExpExecArray | null;
  while ((m = opener.exec(html)) !== null) {
    const innerStart = m.index + m[0].length;
    const end = nextGt(innerStart)?.index ?? html.length;
    if (inside.test(html.slice(innerStart, end))) found.push(m.index);
    // Later openers before the same ">" see only a suffix of this text: they
    // cannot match where this one failed, and a match here already spans them.
    if (end === html.length) break;
    opener.lastIndex = end + 1;
  }
  return found;
}
