/**
 * One forward pass over email HTML.
 *
 * Mail bodies are written by whoever sent them, so every pass over them has to
 * stay linear in the length of the body. Regular expressions such as
 * `/<[^>]+>/g` do not: on a body that opens many tags and never closes one,
 * each opener rescans the rest of the string, and a few tens of kilobytes is
 * enough to hold a request for seconds. Everything that reads markup out of a
 * body goes through this scanner instead. Each search below only ever moves
 * forward, and a search that found nothing is never repeated.
 */

/**
 * The most HTML any one pass reads. Gmail itself clips a message at about
 * 100 KB; anything past this is not something a person reads in a reply,
 * a preview or a draft prompt.
 */
export const MAX_HTML_CHARS = 512 * 1024;

export function capHtml(html: string): string {
  return html.length > MAX_HTML_CHARS ? html.slice(0, MAX_HTML_CHARS) : html;
}

export type HtmlToken =
  | { kind: "text"; start: number; end: number }
  /** `<!-- … -->`. */
  | { kind: "comment"; start: number; end: number }
  /** `<!DOCTYPE …>`, `<?xml …>`, `</ …>`: markup that is never content. */
  | { kind: "markup"; start: number; end: number }
  | {
      kind: "tag";
      start: number;
      end: number;
      /** Lower-cased ASCII name. */
      name: string;
      closing: boolean;
      selfClosing: boolean;
      /** Everything between the name and the closing `>` (or `/>`). */
      attrs: string;
    }
  /** An element whose whole content was skipped, open tag to close tag. */
  | { kind: "dropped"; start: number; end: number; name: string };

const EMPTY: ReadonlySet<string> = new Set();

function isAsciiLetter(code: number): boolean {
  return (code >= 65 && code <= 90) || (code >= 97 && code <= 122);
}

function isAsciiAlnum(code: number): boolean {
  return isAsciiLetter(code) || (code >= 48 && code <= 57);
}

/** The characters `\s` matches in a JavaScript regular expression. */
export function isSpace(code: number): boolean {
  return (
    (code >= 9 && code <= 13) ||
    code === 32 ||
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

/**
 * `indexOf` for a scan that only moves forward: a later call never searches
 * text an earlier call already searched.
 */
function forwardFinder(html: string, needle: string): (from: number) => number {
  let searchedFrom = Number.POSITIVE_INFINITY;
  let found = -1;
  return (from) => {
    if (from >= searchedFrom && (found === -1 || found >= from)) return found;
    searchedFrom = from;
    found = html.indexOf(needle, from);
    return found;
  };
}

/** Finds `</name\s*>` (any case), with the same forward-only guarantee. */
function closeTagFinder(
  html: string,
  name: string,
): (from: number) => [number, number] | null {
  let searchedFrom = Number.POSITIVE_INFINITY;
  let found: [number, number] | null = null;
  return (from) => {
    if (from >= searchedFrom && (found === null || found[0] >= from)) return found;
    searchedFrom = from;
    found = null;
    let pos = from;
    for (;;) {
      const at = html.indexOf("</", pos);
      if (at === -1) break;
      let j = at + 2;
      if (html.slice(j, j + name.length).toLowerCase() === name) {
        j += name.length;
        while (j < html.length && isSpace(html.charCodeAt(j))) j++;
        if (html.charCodeAt(j) === 62) {
          found = [at, j + 1];
          break;
        }
      }
      pos = at + 2;
    }
    return found;
  };
}

/**
 * Tokens of `html`, in order, covering every character exactly once.
 *
 * A `<` starts markup only when a letter, `/`, `!` or `?` follows it, as in a
 * browser; any other `<` is text. Opening tags named in `dropContent` swallow
 * everything up to their matching close tag, when there is one.
 */
export function* htmlTokens(
  html: string,
  dropContent: ReadonlySet<string> = EMPTY,
): Generator<HtmlToken> {
  const n = html.length;
  const nextGt = forwardFinder(html, ">");
  const nextCommentEnd = forwardFinder(html, "-->");
  const closers = new Map<string, (from: number) => [number, number] | null>();
  let textStart = 0;
  let i = 0;

  while (i < n) {
    const lt = html.indexOf("<", i);
    if (lt === -1) break;
    const next = html.charCodeAt(lt + 1);
    const slash = next === 47;
    const bang = next === 33;
    if (!(isAsciiLetter(next) || slash || bang || next === 63)) {
      i = lt + 1;
      continue;
    }
    const gt = nextGt(lt + 1);
    // No `>` anywhere after this point, so nothing after it can be markup.
    if (gt === -1) break;

    let token: HtmlToken | null = null;
    if (bang && html.startsWith("<!--", lt)) {
      const close = nextCommentEnd(lt + 4);
      token =
        close === -1
          ? { kind: "markup", start: lt, end: gt + 1 }
          : { kind: "comment", start: lt, end: close + 3 };
    } else if (!isAsciiLetter(next) && !(slash && isAsciiLetter(html.charCodeAt(lt + 2)))) {
      token = { kind: "markup", start: lt, end: gt + 1 };
    } else {
      const nameStart = slash ? lt + 2 : lt + 1;
      let nameEnd = nameStart;
      while (nameEnd < gt && isAsciiAlnum(html.charCodeAt(nameEnd))) nameEnd++;
      const name = html.slice(nameStart, nameEnd).toLowerCase();
      const selfClosing = gt - 1 >= nameEnd && html.charCodeAt(gt - 1) === 47;
      if (!slash && dropContent.has(name)) {
        let closer = closers.get(name);
        if (!closer) {
          closer = closeTagFinder(html, name);
          closers.set(name, closer);
        }
        const close = closer(gt + 1);
        if (close) token = { kind: "dropped", start: lt, end: close[1], name };
      }
      token ??= {
        kind: "tag",
        start: lt,
        end: gt + 1,
        name,
        closing: slash,
        selfClosing,
        attrs: html.slice(nameEnd, selfClosing ? gt - 1 : gt),
      };
    }

    if (lt > textStart) yield { kind: "text", start: textStart, end: lt };
    yield token;
    i = textStart = token.end;
  }

  if (textStart < n) yield { kind: "text", start: textStart, end: n };
}

/**
 * `name="value"` pairs from the inside of a tag, lower-cased names, in order.
 * Attributes without a value, and a value whose quote never closes, are left
 * out.
 */
export function parseAttributes(raw: string): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  const n = raw.length;
  let i = 0;
  while (i < n) {
    while (i < n && (isSpace(raw.charCodeAt(i)) || raw.charCodeAt(i) === 47)) i++;
    const nameStart = i;
    while (i < n) {
      const c = raw.charCodeAt(i);
      if (isSpace(c) || c === 61 || c === 47 || c === 34 || c === 39 || c === 60 || c === 62) break;
      i++;
    }
    if (i === nameStart) {
      i++;
      continue;
    }
    const name = raw.slice(nameStart, i).toLowerCase();
    let j = i;
    while (j < n && isSpace(raw.charCodeAt(j))) j++;
    if (raw.charCodeAt(j) !== 61) continue;
    j++;
    while (j < n && isSpace(raw.charCodeAt(j))) j++;
    const quote = raw.charCodeAt(j);
    if (quote === 34 || quote === 39) {
      const close = raw.indexOf(raw[j], j + 1);
      if (close === -1) break;
      out.push([name, raw.slice(j + 1, close)]);
      i = close + 1;
      continue;
    }
    const valueStart = j;
    while (j < n) {
      const c = raw.charCodeAt(j);
      if (isSpace(c) || c === 34 || c === 39 || c === 62) break;
      j++;
    }
    if (j > valueStart) out.push([name, raw.slice(valueStart, j)]);
    i = j;
  }
  return out;
}

/**
 * `html` with every tag, comment and declaration replaced by `replacement`.
 * Text, entities included, is left as it was.
 */
export function stripTags(html: string, replacement = " "): string {
  const out: string[] = [];
  for (const token of htmlTokens(html)) {
    out.push(token.kind === "text" ? html.slice(token.start, token.end) : replacement);
  }
  return out.join("");
}

/** A body's HTML as one line of text, for prompts and previews. */
export function flattenHtml(html: string): string {
  return stripTags(capHtml(html)).replace(/\s+/g, " ");
}
