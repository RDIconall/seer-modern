/**
 * One forward pass over email HTML, split into text, tags, comments and the
 * regions whose content is not message text.
 *
 * Mail HTML is written by the sender, so it is hostile input. Regular
 * expressions of the shape `<!--[\s\S]*?-->` or `<x[^>]*>` retry from every
 * opener and rescan the rest of the body each time one is left unclosed: a few
 * hundred kilobytes of `<!--` or `<svg>` then costs seconds. This scanner never
 * looks at a character twice for the same purpose, so its cost is linear in
 * the length of the body whatever the sender writes.
 *
 * An opener with no end runs to the end of the body, as it does in a browser.
 */

export type HtmlToken =
  | { kind: "text"; text: string }
  | { kind: "comment" }
  | { kind: "region"; name: string }
  | { kind: "tag"; name: string; close: boolean; attrs: string; selfClose: boolean };

const isAsciiLetter = (code: number) =>
  (code >= 65 && code <= 90) || (code >= 97 && code <= 122);

const isSpace = (code: number) =>
  code === 32 || code === 9 || code === 10 || code === 12 || code === 13;

/** Longest name in any region set; longer runs cannot close a region. */
const MAX_REGION_NAME = 16;

/**
 * Where every `</name\s*>` for a region name starts and ends, collected once.
 * Each `</` is read once, and only for a bounded number of characters.
 */
function regionClosers(
  html: string,
  regions: ReadonlySet<string>,
): Map<string, { starts: number[]; ends: number[]; next: number }> {
  const closers = new Map<string, { starts: number[]; ends: number[]; next: number }>();
  if (regions.size === 0) return closers;
  let at = html.indexOf("</");
  while (at !== -1) {
    let cursor = at + 2;
    while (
      cursor < html.length &&
      cursor - at - 2 <= MAX_REGION_NAME &&
      isAsciiLetter(html.charCodeAt(cursor))
    ) {
      cursor += 1;
    }
    const name = html.slice(at + 2, cursor).toLowerCase();
    if (name && regions.has(name)) {
      while (cursor < html.length && isSpace(html.charCodeAt(cursor))) cursor += 1;
      if (html.charCodeAt(cursor) === 62 /* > */) {
        let entry = closers.get(name);
        if (!entry) {
          entry = { starts: [], ends: [], next: 0 };
          closers.set(name, entry);
        }
        entry.starts.push(at);
        entry.ends.push(cursor + 1);
      }
    }
    at = html.indexOf("</", Math.max(at + 2, cursor));
  }
  return closers;
}

/**
 * Walk `html` once, front to back, and hand each piece to `visit`.
 *
 * A start tag named in `regions` swallows everything up to its first matching
 * close tag and arrives as one `region` token. One with no close tag arrives
 * as an ordinary tag, so its content is still scanned like any other markup.
 * A `<` that does not open markup arrives as text.
 */
export function scanHtml(
  html: string,
  regions: ReadonlySet<string>,
  visit: (token: HtmlToken) => void,
): void {
  const closers = regionClosers(html, regions);
  let index = 0;
  while (index < html.length) {
    const open = html.indexOf("<", index);
    if (open === -1) {
      visit({ kind: "text", text: html.slice(index) });
      return;
    }
    if (open > index) visit({ kind: "text", text: html.slice(index, open) });

    const next = html.charCodeAt(open + 1);

    if (html.startsWith("<!--", open)) {
      const end = html.indexOf("-->", open + 4);
      visit({ kind: "comment" });
      if (end === -1) return;
      index = end + 3;
      continue;
    }

    // Doctype, CDATA, Outlook's `<![if …]>`, `<?xml …?>`, `</ …>`: all are
    // bogus comments to a browser, ended by the first `>`.
    const closing = next === 47; /* / */
    if (
      next === 33 /* ! */ ||
      next === 63 /* ? */ ||
      (closing && !isAsciiLetter(html.charCodeAt(open + 2)))
    ) {
      const end = html.indexOf(">", open + 2);
      visit({ kind: "comment" });
      if (end === -1) return;
      index = end + 1;
      continue;
    }

    if (!closing && !isAsciiLetter(next)) {
      visit({ kind: "text", text: "<" });
      index = open + 1;
      continue;
    }

    const nameStart = open + (closing ? 2 : 1);
    let nameEnd = nameStart;
    while (nameEnd < html.length) {
      const code = html.charCodeAt(nameEnd);
      if (isSpace(code) || code === 47 /* / */ || code === 62 /* > */) break;
      nameEnd += 1;
    }
    const end = html.indexOf(">", nameEnd);
    // A tag cut off by the end of the body is no tag at all.
    if (end === -1) return;

    const name = html.slice(nameStart, nameEnd).toLowerCase();
    let attrs = html.slice(nameEnd, end);
    const selfClose = !closing && attrs.endsWith("/");
    if (selfClose) attrs = attrs.slice(0, -1);
    index = end + 1;

    if (!closing && regions.has(name)) {
      const entry = closers.get(name);
      if (entry) {
        while (entry.next < entry.starts.length && entry.starts[entry.next] < index) {
          entry.next += 1;
        }
        if (entry.next < entry.starts.length) {
          visit({ kind: "region", name });
          index = entry.ends[entry.next];
          entry.next += 1;
          continue;
        }
      }
    }

    visit({ kind: "tag", name, close: closing, attrs, selfClose });
  }
}

/** The text a reader would see, tags gone and entities left as written. */
export function visibleMarkupText(html: string): string {
  const parts: string[] = [];
  scanHtml(html, new Set(), (token) => {
    if (token.kind === "text") parts.push(token.text);
    else parts.push(" ");
  });
  return parts.join("");
}
