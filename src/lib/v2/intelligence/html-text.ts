/**
 * Turn an email's HTML into the text a person would actually read.
 *
 * The naive `replace(/<[^>]+>/g, "")` removes tags but keeps the CONTENT of
 * <style> and <script>, so the model ends up reading CSS rules as if they were
 * the message. It also leaves entities raw ("&gt;", "&nbsp;"). The standard we
 * hold this to: what you would see if you pasted the email into a chat.
 */

const BLOCK_LEVEL = /<\/?(p|div|tr|li|h[1-6]|blockquote|table|section|article)\b[^>]*>/gi;

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

export function htmlToText(html: string): string {
  return decodeEntities(
    html
      // Drop non-content regions entirely, including their contents.
      .replace(/<!--[\s\S]*?-->/g, " ")
      .replace(/<(script|style|head|noscript)\b[^>]*>[\s\S]*?<\/\1>/gi, " ")
      // Preserve document structure as line breaks so sentences don't fuse.
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(BLOCK_LEVEL, "\n")
      // Everything else is markup.
      .replace(/<[^>]+>/g, " "),
  )
    .replace(/[ \t\u00a0]+/g, " ")
    .replace(/\n\s*\n\s*\n+/g, "\n\n")
    .split("\n")
    .map((line) => line.trim())
    .join("\n")
    .trim();
}

/**
 * The plain text of an email whose parts arrive as separate strings.
 *
 * Every reading pane renders the HTML part when there is one, and the sender
 * writes both parts of a multipart/alternative message, so a text/plain part
 * may say something the person never sees. Whatever is graded, stored, quoted
 * or forwarded therefore comes from the HTML whenever it exists; the text part
 * stands in only for mail that has no HTML part.
 */
export function visibleBodyText(
  html: string | null | undefined,
  text: string | null | undefined,
): string | null {
  if (html?.trim()) return htmlToText(html) || null;
  return text ?? null;
}

/**
 * Persistable plain text for a message, derived the way the reader shows it
 * (see `visibleBodyText`) so later reads do not have to detoast `body_html`.
 * HTML with no text in it (style-only mail) stores null.
 */
export function storedBodyText(message: {
  bodyText: string | null;
  bodyHtml: string | null;
}): string | null {
  return visibleBodyText(message.bodyHtml, message.bodyText);
}

/** The readable body of a message: the text the reading pane shows. */
export function readableBody(message: {
  bodyText: string | null;
  bodyHtml: string | null;
  snippet: string;
}): string {
  const text = storedBodyText(message)?.trim();
  if (text) return text;
  return message.snippet ?? "";
}
