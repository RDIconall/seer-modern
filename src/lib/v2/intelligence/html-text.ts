/**
 * Turn an email's HTML into the text a person would actually read.
 *
 * The naive `replace(/<[^>]+>/g, "")` removes tags but keeps the CONTENT of
 * <style> and <script>, so the model ends up reading CSS rules as if they were
 * the message. It also leaves entities raw ("&gt;", "&nbsp;"). The standard we
 * hold this to: what you would see if you pasted the email into a chat.
 */

import { capHtml, htmlTokens } from "../../html/scan";

/** Regions that are not content: they leave with everything inside them. */
const NON_CONTENT = new Set(["script", "style", "head", "noscript"]);

const BLOCK_LEVEL = new Set([
  "p", "div", "tr", "li", "h1", "h2", "h3", "h4", "h5", "h6",
  "blockquote", "table", "section", "article",
]);

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

function decodeEntities(s: string): string {
  return s
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) =>
      String.fromCodePoint(parseInt(hex, 16)),
    )
    .replace(/&([a-z]+);/gi, (match, name: string) => ENTITIES[name.toLowerCase()] ?? match);
}

function markupToText(html: string): string {
  const out: string[] = [];
  for (const token of htmlTokens(html, NON_CONTENT)) {
    if (token.kind === "text") {
      out.push(html.slice(token.start, token.end));
    } else if (
      token.kind === "tag" &&
      // Document structure becomes line breaks so sentences don't fuse.
      ((token.name === "br" && token.attrs.trim() === "") || BLOCK_LEVEL.has(token.name))
    ) {
      out.push("\n");
    } else {
      out.push(" ");
    }
  }
  return out.join("");
}

/** Trimmed lines, with any run of blank lines kept as one. */
function tidyLines(text: string): string {
  const out: string[] = [];
  let blankPending = false;
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line) {
      blankPending = out.length > 0;
      continue;
    }
    if (blankPending) out.push("");
    out.push(line);
    blankPending = false;
  }
  return out.join("\n");
}

export function htmlToText(html: string): string {
  return tidyLines(
    decodeEntities(markupToText(capHtml(html))).replace(/[ \t\u00a0]+/g, " "),
  );
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
