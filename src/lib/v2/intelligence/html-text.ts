/**
 * Turn an email's HTML into the text a person would actually read.
 *
 * The naive `replace(/<[^>]+>/g, "")` removes tags but keeps the CONTENT of
 * <style> and <script>, so the model ends up reading CSS rules as if they were
 * the message. It also leaves entities raw ("&gt;", "&nbsp;"). The standard we
 * hold this to: what you would see if you pasted the email into a chat.
 *
 * Bodies are sender-controlled, so every pass here is a single forward scan.
 * A tag regex like `/<[^>]+>/g` rescans the rest of the string at every "<"
 * that has no ">" after it, and a body of nothing but "<" turns that into
 * minutes of CPU for one message.
 */

/**
 * The most HTML read for text. Far past any human-written body, and every
 * caller shortens the text further before it is used.
 */
export const MAX_HTML_TEXT_CHARS = 1_048_576;

const BLOCK_LEVEL = new Set([
  "p", "div", "tr", "li", "h1", "h2", "h3", "h4", "h5", "h6",
  "blockquote", "table", "section", "article",
]);

/** Elements dropped together with everything up to their closing tag. */
const NON_CONTENT = new Set(["script", "style", "head", "noscript"]);

const TAG_NAME = /^\/?([a-zA-Z][a-zA-Z0-9]*)\b/;

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  mdash: "—",
  ndash: "–",
  hellip: "…",
  rsquo: "’",
  lsquo: "‘",
  ldquo: "“",
  rdquo: "”",
};

function codePoint(code: number, raw: string): string {
  return Number.isInteger(code) && code >= 0 && code <= 0x10ffff
    ? String.fromCodePoint(code)
    : raw;
}

function decodeEntities(s: string): string {
  return s
    .replace(/&#(\d+);/g, (raw, code: string) => codePoint(Number(code), raw))
    .replace(/&#x([0-9a-f]+);/gi, (raw, hex: string) =>
      codePoint(parseInt(hex, 16), raw),
    )
    .replace(/&([a-z]+);/gi, (match, name: string) => ENTITIES[name.toLowerCase()] ?? match);
}

/**
 * `html.replace(/<[^>]+>/g, replacement)` in one pass. Once a "<" has no ">"
 * after it, no later "<" does either, so the rest is copied as text.
 */
export function stripTags(html: string, replacement = " "): string {
  const out: string[] = [];
  let i = 0;
  while (i < html.length) {
    const lt = html.indexOf("<", i);
    if (lt === -1) break;
    const gt = html.indexOf(">", lt + 1);
    if (gt === -1) break;
    if (gt === lt + 1) {
      out.push(html.slice(i, gt));
      i = gt;
      continue;
    }
    out.push(html.slice(i, lt), replacement);
    i = gt + 1;
  }
  out.push(html.slice(i));
  return out.join("");
}

function closingTagEnd(
  html: string,
  name: string,
  from: number,
  closers: Map<string, RegExp | null>,
): number {
  let closer = closers.get(name);
  if (closer === null) return -1;
  if (!closer) {
    closer = new RegExp(`</${name}>`, "gi");
    closers.set(name, closer);
  }
  closer.lastIndex = from;
  const found = closer.exec(html);
  if (!found) {
    // No later opener of this element can find a closer either.
    closers.set(name, null);
    return -1;
  }
  return found.index + found[0].length;
}

export function htmlToText(html: string): string {
  const source =
    html.length > MAX_HTML_TEXT_CHARS ? html.slice(0, MAX_HTML_TEXT_CHARS) : html;
  const out: string[] = [];
  const closers = new Map<string, RegExp | null>();
  let i = 0;
  while (i < source.length) {
    const lt = source.indexOf("<", i);
    if (lt === -1) break;

    // Drop non-content regions entirely, including their contents. An
    // unterminated comment runs to the end of the document, as in a browser.
    if (source.startsWith("<!--", lt)) {
      out.push(source.slice(i, lt), " ");
      const end = source.indexOf("-->", lt + 4);
      i = end === -1 ? source.length : end + 3;
      continue;
    }

    const gt = source.indexOf(">", lt + 1);
    if (gt === -1) break;
    if (gt === lt + 1) {
      out.push(source.slice(i, gt));
      i = gt;
      continue;
    }

    out.push(source.slice(i, lt));
    const tag = source.slice(lt + 1, gt);
    const name = TAG_NAME.exec(tag)?.[1]?.toLowerCase() ?? "";
    const closing = tag.startsWith("/");
    i = gt + 1;

    if (!closing && NON_CONTENT.has(name)) {
      const end = closingTagEnd(source, name, i, closers);
      if (end !== -1) {
        out.push(" ");
        i = end;
        continue;
      }
    }
    // Preserve document structure as line breaks so sentences don't fuse.
    if (name === "br" || BLOCK_LEVEL.has(name)) {
      out.push("\n");
      continue;
    }
    out.push(" ");
  }
  out.push(source.slice(i));

  const lines = decodeEntities(out.join(""))
    .replace(/[ \t\u00a0]+/g, " ")
    .split("\n");
  const kept: string[] = [];
  for (const raw of lines) {
    const line = raw.trim();
    // At most one blank line between paragraphs.
    if (!line && kept.length > 0 && kept[kept.length - 1] === "") continue;
    kept.push(line);
  }
  return kept.join("\n").trim();
}

/**
 * Persistable plain text for a message. Prefers the provider's text part;
 * otherwise derives it from HTML so later reads do not have to detoast
 * `body_html`. Empty HTML (style-only mail) falls through to the original
 * text part, which may still be null.
 */
export function storedBodyText(message: {
  bodyText: string | null;
  bodyHtml: string | null;
}): string | null {
  const text = message.bodyText?.trim();
  if (text) return message.bodyText;
  if (message.bodyHtml) {
    const converted = htmlToText(message.bodyHtml);
    if (converted) return converted;
  }
  return message.bodyText;
}

/** The readable body of a message, preferring real text over derived text. */
export function readableBody(message: {
  bodyText: string | null;
  bodyHtml: string | null;
  snippet: string;
}): string {
  const text = storedBodyText(message)?.trim();
  if (text) return text;
  return message.snippet ?? "";
}

/**
 * Single-line text for a legacy mail message: the text part when there is
 * one, otherwise the HTML part read as text.
 */
export function messageBodyText(message: {
  textBody: string;
  htmlBody: string;
}): string {
  return message.textBody || htmlToText(message.htmlBody).replace(/\s+/g, " ");
}
