import { htmlToText } from "@/lib/v2/intelligence/html-text";

const TEXT_QUOTE_MARKER =
  /^(?:On .+wrote:|From:\s.+|-----Original Message-----|_{5,})$/im;
const HTML_QUOTE_MARKER = /(?:gmail_quote|blockquote|Original Message)/i;

function freshText(text: string): { text: string; quoted: boolean } {
  const match = TEXT_QUOTE_MARKER.exec(text);
  if (!match?.index) return { text, quoted: false };
  return { text: text.slice(0, match.index).trim(), quoted: true };
}

export type LegacyDisplayedBody = {
  /** HTML the legacy thread renders, or null when it renders `text`. */
  html: string | null;
  /** Text shown when `html` is null, and the fallback if `html` renders empty. */
  text: string;
  /** Quoted history was cut from what is shown. */
  quoted: boolean;
  /**
   * The MIME part on screen, as text. Grading, deep reads, drafts and forwards
   * must read this: a multipart/alternative message can say something
   * different in the part the person never sees.
   */
  bodyText: string;
};

/**
 * Which part of a Gmail/Graph message the legacy thread shows. The HTML part
 * wins whenever it has text and no quote marker; the plain part is shown, and
 * read, only otherwise.
 */
export function legacyDisplayedBody(message: {
  htmlBody: string;
  textBody: string;
}): LegacyDisplayedBody {
  const htmlBody = message.htmlBody ?? "";
  const textBody = message.textBody ?? "";
  const fresh = freshText(textBody);
  const quoted = fresh.quoted || HTML_QUOTE_MARKER.test(htmlBody);
  const htmlText = htmlBody ? htmlToText(htmlBody) : "";
  if (!quoted && htmlBody.trim() && (htmlText || !textBody.trim())) {
    return { html: htmlBody, text: htmlText, quoted: false, bodyText: htmlText };
  }
  return {
    html: null,
    text: fresh.text || textBody || htmlText,
    quoted,
    bodyText: textBody || htmlText,
  };
}
