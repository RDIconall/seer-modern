/**
 * Turn an email's HTML into the text a person would actually read.
 *
 * The naive `replace(/<[^>]+>/g, "")` removes tags but keeps the CONTENT of
 * <style> and <script>, so the model ends up reading CSS rules as if they were
 * the message. It also leaves entities raw ("&gt;", "&nbsp;"). The standard we
 * hold this to: what you would see if you pasted the email into a chat.
 */

/**
 * Every element that ends a line when a person reads the mail. Table cells and
 * list wrappers belong here: Outlook lays paragraphs out in tables, and without
 * `td` every row of a weekly report fuses into one sentence.
 */
const BLOCK_LEVEL =
  /<\/?(p|div|tr|td|th|li|ul|ol|dl|dt|dd|h[1-6]|blockquote|table|thead|tbody|tfoot|section|article|header|footer|pre|hr|figure|figcaption)\b[^>]*>/gi;

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

/** The readable body of a message, preferring real text over derived text. */
export function readableBody(message: {
  bodyText: string | null;
  bodyHtml: string | null;
  snippet: string;
}): string {
  const text = message.bodyText?.trim();
  if (text) return text;
  if (message.bodyHtml) {
    const converted = htmlToText(message.bodyHtml);
    if (converted) return converted;
  }
  return message.snippet ?? "";
}
