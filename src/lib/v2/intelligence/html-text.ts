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
