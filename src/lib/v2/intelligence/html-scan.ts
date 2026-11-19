/**
 * One forward pass over email HTML.
 *
 * Mail bodies are attacker-controlled and are converted synchronously while a
 * sync page is written, so nothing here may cost more than linear time. The
 * regular expressions this replaces (`<[^>]+>`, `<!--[\s\S]*?-->`,
 * `<script>[\s\S]*?</script>`) rescan the rest of the string from every
 * candidate whose terminator is missing, which is quadratic on a body of
 * unclosed tags. Every search below starts where the previous one stopped.
 */

export type HtmlTag = {
  /** Lower-cased tag name. */
  name: string;
  closing: boolean;
  selfClosing: boolean;
  /** Raw text between the tag name and the closing `>`, minus a trailing `/`. */
  attrs: string;
  /** Offset of the `<` that opened the tag. */
  start: number;
};

export type HtmlVisitor = {
  text?(text: string): void;
  tag?(tag: HtmlTag): void;
  /** A comment, doctype, processing instruction or other `<!…>` / `<?…>`. */
  declaration?(): void;
  /** An element from `skipContent` that was dropped together with its content. */
  skipped?(tag: HtmlTag): void;
};

export type ScanOptions = {
  /**
   * Elements whose content is dropped with them when a closing tag follows.
   * Without one, only the opening tag is reported and its content is text.
   */
  skipContent?: ReadonlySet<string>;
};

const GT = 0x3e;
const SLASH = 0x2f;
const BANG = 0x21;
const QUESTION = 0x3f;
const EQUALS = 0x3d;
const DOUBLE_QUOTE = 0x22;
const SINGLE_QUOTE = 0x27;
const DASH = 0x2d;

function isAsciiLetter(code: number): boolean {
  return (code >= 0x41 && code <= 0x5a) || (code >= 0x61 && code <= 0x7a);
}

function isHtmlSpace(code: number): boolean {
  return code === 0x20 || code === 0x09 || code === 0x0a || code === 0x0c || code === 0x0d;
}

/** Matches the `\s` class of JavaScript regular expressions. */
export function isWhitespace(code: number): boolean {
  if (code === 0x20 || (code >= 0x09 && code <= 0x0d) || code === 0xa0) return true;
  return code > 0x7f && /\s/.test(String.fromCharCode(code));
}

function parseTag(html: string, start: number, end: number): HtmlTag {
  let p = start + 1;
  const closing = html.charCodeAt(p) === SLASH;
  if (closing) p += 1;
  let q = p;
  while (q < end) {
    const code = html.charCodeAt(q);
    if (isHtmlSpace(code) || code === SLASH) break;
    q += 1;
  }
  let attrs = html.slice(q, end);
  const selfClosing = attrs.endsWith("/");
  if (selfClosing) attrs = attrs.slice(0, -1);
  return { name: html.slice(p, q).toLowerCase(), closing, selfClosing, attrs, start };
}

export function scanHtml(html: string, visitor: HtmlVisitor, options: ScanOptions = {}): void {
  const skipContent = options.skipContent;
  const length = html.length;
  // Next "</name" at or after the last search, or -1 once none remains.
  // The scan only moves forward, so a remembered position stays valid until
  // the scan passes it, and each stretch of input is searched once per name.
  const closers = new Map<string, number>();
  const findCloser = (name: string, from: number): number => {
    const known = closers.get(name);
    if (known !== undefined && (known === -1 || known >= from)) return known;
    const pattern = new RegExp(`</${name}(?=[\\s/>])`, "gi");
    pattern.lastIndex = from;
    const found = pattern.exec(html);
    const at = found ? found.index : -1;
    closers.set(name, at);
    return at;
  };

  let textStart = 0;
  let i = 0;
  const flushText = (until: number) => {
    if (until > textStart) visitor.text?.(html.slice(textStart, until));
  };

  while (i < length) {
    const lt = html.indexOf("<", i);
    if (lt === -1) break;
    const next = html.charCodeAt(lt + 1);
    const opensTag =
      isAsciiLetter(next) || (next === SLASH && isAsciiLetter(html.charCodeAt(lt + 2)));

    if (opensTag) {
      flushText(lt);
      const end = html.indexOf(">", lt + 1);
      // End of input inside a tag: a browser shows none of what follows.
      if (end === -1) return;
      const tag = parseTag(html, lt, end);
      i = end + 1;
      textStart = i;
      if (!tag.closing && skipContent?.has(tag.name)) {
        const closer = findCloser(tag.name, i);
        if (closer !== -1) {
          visitor.skipped?.(tag);
          const closerEnd = html.indexOf(">", closer);
          if (closerEnd === -1) return;
          i = closerEnd + 1;
          textStart = i;
          continue;
        }
      }
      visitor.tag?.(tag);
      continue;
    }

    if (next === BANG || next === QUESTION || next === SLASH) {
      flushText(lt);
      let end: number;
      if (html.startsWith("<!--", lt)) {
        if (html.charCodeAt(lt + 4) === GT) end = lt + 5;
        else if (html.charCodeAt(lt + 4) === DASH && html.charCodeAt(lt + 5) === GT) end = lt + 6;
        else {
          // An unclosed comment runs to the end of the input.
          const close = html.indexOf("-->", lt + 4);
          end = close === -1 ? length : close + 3;
        }
      } else {
        const close = html.indexOf(">", lt + 2);
        end = close === -1 ? length : close + 1;
      }
      visitor.declaration?.();
      i = end;
      textStart = i;
      continue;
    }

    // A "<" that opens nothing is text.
    i = lt + 1;
  }
  flushText(length);
}

/**
 * Exactly `html.replace(/<[^>]+>/g, replacement)`, in linear time.
 *
 * Once a "<" has no ">" after it, no later "<" has one either, so the rest of
 * the input is copied without searching again.
 */
export function stripTags(html: string, replacement = " "): string {
  const parts: string[] = [];
  let i = 0;
  for (;;) {
    const lt = html.indexOf("<", i);
    if (lt === -1) break;
    if (html.charCodeAt(lt + 1) === GT) {
      parts.push(html.slice(i, lt + 2));
      i = lt + 2;
      continue;
    }
    const gt = html.indexOf(">", lt + 1);
    if (gt === -1) break;
    parts.push(html.slice(i, lt), replacement);
    i = gt + 1;
  }
  parts.push(html.slice(i));
  return parts.join("");
}

export type HtmlAttribute = { name: string; value: string };

/** The attributes in a tag's raw attribute text, read left to right once. */
export function parseAttributes(raw: string): HtmlAttribute[] {
  const out: HtmlAttribute[] = [];
  const length = raw.length;
  let i = 0;
  while (i < length) {
    const code = raw.charCodeAt(i);
    if (isHtmlSpace(code) || code === SLASH) {
      i += 1;
      continue;
    }
    let j = i + 1;
    while (j < length) {
      const c = raw.charCodeAt(j);
      if (isHtmlSpace(c) || c === SLASH || c === EQUALS) break;
      j += 1;
    }
    const name = raw.slice(i, j).toLowerCase();
    i = j;
    while (i < length && isHtmlSpace(raw.charCodeAt(i))) i += 1;
    if (raw.charCodeAt(i) !== EQUALS) {
      out.push({ name, value: "" });
      continue;
    }
    i += 1;
    while (i < length && isHtmlSpace(raw.charCodeAt(i))) i += 1;
    const quote = raw.charCodeAt(i);
    if (quote === DOUBLE_QUOTE || quote === SINGLE_QUOTE) {
      const close = raw.indexOf(String.fromCharCode(quote), i + 1);
      const stop = close === -1 ? length : close;
      out.push({ name, value: raw.slice(i + 1, stop) });
      i = close === -1 ? length : close + 1;
      continue;
    }
    let k = i;
    while (k < length && !isHtmlSpace(raw.charCodeAt(k))) k += 1;
    out.push({ name, value: raw.slice(i, k) });
    i = k;
  }
  return out;
}
