/**
 * Turn an email's HTML into the text a person would actually read.
 *
 * The naive `replace(/<[^>]+>/g, "")` removes tags but keeps the CONTENT of
 * <style> and <script>, so the model ends up reading CSS rules as if they were
 * the message. It also leaves entities raw ("&gt;", "&nbsp;"). The standard we
 * hold this to: what you would see if you pasted the email into a chat.
 *
 * Conversion runs synchronously inside the sync page write, on mail anyone
 * can send, so it is a single linear scan (see html-scan.ts) over a bounded
 * prefix of the body.
 */

import { scanHtml } from "./html-scan";

/**
 * Longest HTML body converted to text. Far beyond any real message's text,
 * and it keeps the work per message bounded however large the body is.
 */
export const MAX_HTML_TO_TEXT_CHARS = 1_000_000;

const BLOCK_LEVEL = new Set([
  "p", "div", "tr", "li", "h1", "h2", "h3", "h4", "h5", "h6",
  "blockquote", "table", "section", "article",
]);

/** Non-content regions, dropped together with their contents. */
const SKIP_CONTENT = new Set(["script", "style", "head", "noscript"]);

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

const ENTITY = /&(?:#(\d+)|#x([0-9a-f]+)|([a-z]+));/gi;

function decodeEntities(s: string): string {
  return s.replace(
    ENTITY,
    (match, decimal: string | undefined, hex: string | undefined, name: string | undefined) => {
      if (name !== undefined) return ENTITIES[name.toLowerCase()] ?? match;
      const code = decimal !== undefined ? Number(decimal) : parseInt(hex ?? "", 16);
      // Out-of-range references would make String.fromCodePoint throw.
      return code <= 0x10ffff ? String.fromCodePoint(code) : "\uFFFD";
    },
  );
}

/** Trim every line and keep at most one blank line between paragraphs. */
function tidyLines(s: string): string {
  const lines: string[] = [];
  for (const raw of s.replace(/[ \t\u00a0]+/g, " ").split("\n")) {
    const line = raw.trim();
    if (line === "" && (lines.length === 0 || lines[lines.length - 1] === "")) continue;
    lines.push(line);
  }
  while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines.join("\n");
}

export function htmlToText(html: string): string {
  const source = html.length > MAX_HTML_TO_TEXT_CHARS ? html.slice(0, MAX_HTML_TO_TEXT_CHARS) : html;
  const parts: string[] = [];
  scanHtml(
    source,
    {
      text: (text) => parts.push(text),
      // Preserve document structure as line breaks so sentences don't fuse.
      tag: (tag) => parts.push(tag.name === "br" || BLOCK_LEVEL.has(tag.name) ? "\n" : " "),
      declaration: () => parts.push(" "),
      skipped: () => parts.push(" "),
    },
    { skipContent: SKIP_CONTENT },
  );
  return tidyLines(decodeEntities(parts.join("")));
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
