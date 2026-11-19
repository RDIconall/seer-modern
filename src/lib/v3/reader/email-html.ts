/**
 * Email HTML, made readable without being trusted.
 *
 * Mail bodies arrive as whole documents: Outlook and Gmail ship their own
 * fonts, their own black-on-white colours, and the entire quoted thread under
 * the new sentence. Rendering that raw breaks the theme (black text on the
 * dark skin is invisible) and rendering it as flattened plain text loses the
 * thing that made it readable in the first place — paragraphs, lists, tables
 * and emphasis.
 *
 * So the body keeps its STRUCTURE and loses its PRESENTATION: block elements,
 * lists and links survive; colours, fonts and sizes are dropped so the message
 * inherits Seer's typography and reads the same in both themes.
 *
 * This module runs on the server as well as the client, so it cannot lean on
 * the DOM. DOMPurify still runs over the result in the browser — this is the
 * structural pass, not the only line of defence.
 *
 * The body is sender-controlled, so every pass is linear: tag spans come from
 * `html-scan`, and the remaining patterns stop at the next `<` so they cannot
 * rescan the rest of the body from every opener.
 */
import {
  replaceDelimited,
  replaceElementsWithContent,
  replaceOpeningTags,
  stripTags,
} from "@/lib/mail/html-scan";

/** Elements that carry meaning. Anything else is unwrapped, keeping its text. */
const ALLOWED_TAGS = new Set([
  "a", "b", "blockquote", "br", "caption", "code", "col", "colgroup", "dd",
  "div", "dl", "dt", "em", "figure", "figcaption", "h1", "h2", "h3", "h4",
  "h5", "h6", "hr", "i", "img", "li", "ol", "p", "pre", "s", "small", "span",
  "strong", "sub", "sup", "table", "tbody", "td", "tfoot", "th", "thead",
  "tr", "u", "ul",
]);

/** Elements whose CONTENT is not message text and must go with them. */
const VOID_CONTENT =
  /<(script|style|head|noscript|iframe|object|embed|template|form|svg|math|title)\b/i;

const ORPHAN_DANGEROUS =
  /<\/?(script|style|head|noscript|iframe|object|embed|template|form|svg|math|title|link|meta|base|input|button|select|textarea)\b/i;

const ELEMENT = /<(\/?)([a-zA-Z][a-zA-Z0-9]*)\b/;

const ATTRIBUTE = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*("([^"]*)"|'([^']*)'|([^\s"'>]+))/y;
const ATTRIBUTE_NAME_START = /[a-zA-Z_:]/;
const ATTRIBUTE_NAME_CHAR = /[-a-zA-Z0-9_:.]/;

/**
 * Style declarations worth keeping. Colour, font and size are deliberately
 * absent: they are the sender's theme, and honouring them is what puts black
 * text on a dark background.
 */
const ALLOWED_STYLE = new Set([
  "font-weight",
  "font-style",
  "text-decoration",
  "text-align",
  "list-style-type",
  "margin-left",
  "padding-left",
  "border-left",
  "border-collapse",
]);

const ALLOWED_ATTRS: Record<string, Set<string>> = {
  a: new Set(["href", "title", "style"]),
  img: new Set(["src", "alt", "title", "width", "height", "style"]),
  td: new Set(["colspan", "rowspan", "align", "style"]),
  th: new Set(["colspan", "rowspan", "align", "style"]),
  table: new Set(["align", "style"]),
  col: new Set(["span", "style"]),
  colgroup: new Set(["span", "style"]),
  ol: new Set(["start", "type", "style"]),
};

const DEFAULT_ATTRS = new Set(["style", "dir"]);

function safeUrl(value: string, allowData: boolean): string | null {
  const trimmed = value.trim().replace(/[\u0000-\u001f]/g, "");
  if (/^(https?:|mailto:|tel:)/i.test(trimmed)) return trimmed;
  if (allowData && /^data:image\/(png|jpe?g|gif|webp);base64,/i.test(trimmed)) {
    return trimmed;
  }
  if (/^(cid:|#)/i.test(trimmed)) return null;
  return null;
}

function filterStyle(value: string): string | null {
  const kept = value
    .split(";")
    .map((declaration) => declaration.trim())
    .filter((declaration) => {
      const property = declaration.split(":")[0]?.trim().toLowerCase();
      if (!property || !ALLOWED_STYLE.has(property)) return false;
      // url() can smuggle a request; no allowed property needs one.
      return !/url\s*\(|expression\s*\(/i.test(declaration);
    });
  return kept.length > 0 ? kept.join("; ") : null;
}

function escapeAttr(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}

function rebuildAttributes(tag: string, raw: string): string {
  const allowed = ALLOWED_ATTRS[tag] ?? DEFAULT_ATTRS;
  const out: string[] = [];
  let at = 0;
  while (at < raw.length) {
    ATTRIBUTE.lastIndex = at;
    const match = ATTRIBUTE.exec(raw);
    if (!match) {
      // A name with no `=value` after it fails from every later offset in the
      // same name too, so skip the whole name instead of retrying each suffix.
      if (ATTRIBUTE_NAME_START.test(raw[at])) {
        while (at < raw.length && ATTRIBUTE_NAME_CHAR.test(raw[at])) at += 1;
      } else {
        at += 1;
      }
      continue;
    }
    at = ATTRIBUTE.lastIndex;
    const name = match[1].toLowerCase();
    const value = match[3] ?? match[4] ?? match[5] ?? "";
    if (!allowed.has(name)) continue;
    if (name === "href" || name === "src") {
      const url = safeUrl(value, name === "src");
      if (!url) continue;
      out.push(`${name}="${escapeAttr(url)}"`);
      continue;
    }
    if (name === "style") {
      const style = filterStyle(value);
      if (!style) continue;
      out.push(`style="${escapeAttr(style)}"`);
      continue;
    }
    if (name === "width" || name === "height" || name === "colspan" || name === "rowspan" || name === "span" || name === "start") {
      if (!/^\d{1,5}$/.test(value.trim())) continue;
      out.push(`${name}="${value.trim()}"`);
      continue;
    }
    out.push(`${name}="${escapeAttr(value)}"`);
  }
  if (tag === "a") out.push('target="_blank"', 'rel="noopener noreferrer"');
  return out.length > 0 ? ` ${out.join(" ")}` : "";
}

/**
 * Keep the structure, drop the sender's presentation and anything executable.
 * Unknown tags are unwrapped rather than deleted, so no text is ever lost to
 * a wrapper Seer does not recognise.
 */
export function sanitizeStructuralHtml(html: string): string {
  if (!html) return "";
  let s = replaceDelimited(html, /<!--/, "-->", "");
  s = replaceDelimited(s, /<!DOCTYPE/i, ">", "");
  s = replaceDelimited(s, /<\?/, "?>", "");
  s = replaceElementsWithContent(s, VOID_CONTENT, " ", true);
  s = replaceOpeningTags(s, ORPHAN_DANGEROUS, " ");
  s = replaceOpeningTags(s, ELEMENT, (match, rest) => {
    const close = match[1];
    const tag = match[2].toLowerCase();
    const selfClose = rest.endsWith("/");
    const attrs = selfClose ? rest.slice(0, -1) : rest;
    if (!ALLOWED_TAGS.has(tag)) return "";
    if (close) return `</${tag}>`;
    if (tag === "br" || tag === "hr" || tag === "img" || tag === "col") {
      return `<${tag}${rebuildAttributes(tag, attrs)} />`;
    }
    return `<${tag}${rebuildAttributes(tag, attrs)}${selfClose ? " /" : ""}>`;
  });
  return collapseBreaks(s).trim();
}

/**
 * Three or more consecutive `<br />` (and the whitespace around them) become
 * two. Matching from the first break rather than from the whitespace before
 * it keeps a long whitespace run from being rescanned at every offset.
 */
function collapseBreaks(html: string): string {
  const run = /<br\s*\/>(?:\s*<br\s*\/>){2,}\s*/gi;
  let out = "";
  let at = 0;
  let match: RegExpExecArray | null;
  while ((match = run.exec(html)) !== null) {
    out += html.slice(at, match.index).trimEnd() + "<br /><br />";
    at = run.lastIndex;
  }
  return out + html.slice(at);
}

/**
 * Where the quoted history starts, in the shapes the clients write it. Outlook
 * opens with an `appendonsend` anchor or a `divRplyFwdMsg` header block; Gmail,
 * Thunderbird and Yahoo each name their own wrapper; and any client may write
 * an "Original Message" divider (found by `nextDivider`).
 */
const QUOTE_OPENERS: RegExp[] = [
  /<div[^<>]*id=["']?appendonsend["']?/i,
  /<div[^<>]*id=["']?divRplyFwdMsg["']?/i,
  /<div[^<>]*class=["'][^"']*gmail_quote/i,
  /<div[^<>]*class=["'][^"']*moz-cite-prefix/i,
  /<div[^<>]*(?:id|class)=["'][^"']*yahoo_quoted/i,
  /<blockquote[^<>]*type=["']?cite/i,
  /<blockquote[^<>]*class=["'][^"']*(?:gmail_quote|moz-cite|yahoo_quoted)/i,
];

const WHITESPACE = /\s/;

/**
 * The next `-{2,}\s*Original Message\s*-{2,}` at or after `from`. Anchored on
 * the words, then measured outwards, because the regex itself retries from
 * every dash of a long run.
 */
function nextDivider(html: string, from: number): { index: number; end: number } | null {
  const words = /original message/gi;
  words.lastIndex = from;
  let found: RegExpExecArray | null;
  while ((found = words.exec(html)) !== null) {
    let before = found.index;
    while (before > from && WHITESPACE.test(html[before - 1])) before -= 1;
    let start = before;
    while (start > from && html[start - 1] === "-") start -= 1;
    if (before - start < 2) continue;
    let after = found.index + found[0].length;
    while (after < html.length && WHITESPACE.test(html[after])) after += 1;
    let end = after;
    while (end < html.length && html[end] === "-") end += 1;
    if (end - after < 2) continue;
    return { index: start, end };
  }
  return null;
}

function countDividers(html: string): number {
  let count = 0;
  let at = 0;
  let divider: { index: number; end: number } | null;
  while ((divider = nextDivider(html, at)) !== null) {
    count += 1;
    at = divider.end;
  }
  return count;
}

/** Every blockquote, so each can be judged on what stands above it. */
const ANY_BLOCKQUOTE = /<blockquote\b/gi;

/**
 * The line a mail client writes directly above the message it is quoting.
 *
 * A bare <blockquote> is NOT evidence of quoting. Zoho wraps an entire outbound
 * mail in `<blockquote id="blockquote_zmail">`, nested once per send, and
 * plenty of newsletters indent a pull quote the same way. Cutting on the tag
 * alone deleted the whole message and reported it as history that was never
 * there. So a blockquote only closes the fresh body when a client announced the
 * quote above it: an attribution line, or an Outlook-style header block.
 */
const ATTRIBUTIONS: RegExp[] = [
  /\bwrote:\s*$/i,
  /\bsaid:\s*$/i,
  /-{2,}\s*original message\s*-{2,}\s*$/i,
  /\bbegin forwarded message:\s*$/i,
  /\bfrom:[\s\S]{0,300}?\b(?:sent|date|to):[\s\S]{0,300}$/i,
];

/** Markers that each open one more quoted message, for the hidden count. */
const QUOTE_COUNTERS: RegExp[] = [
  /<div[^<>]*id=["']?divRplyFwdMsg["']?/gi,
  /<div[^<>]*class=["'][^"']*gmail_quote/gi,
  /<blockquote[^<>]*type=["']?cite/gi,
  /\bwrote:/gi,
];

/** The last of the text a reader would see before `index`, tags removed. */
function textBefore(html: string, index: number): string {
  return stripTags(html.slice(Math.max(0, index - 600), index))
    .replace(/&nbsp;/gi, " ")
    .replace(/&[a-z#0-9]+;/gi, " ")
    .replace(/\s+/g, " ")
    .trimEnd()
    .slice(-300);
}

/** The first blockquote a client actually announced as a quote, if any. */
function announcedBlockquote(html: string): number {
  ANY_BLOCKQUOTE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = ANY_BLOCKQUOTE.exec(html)) !== null) {
    const preceding = textBefore(html, match.index);
    if (ATTRIBUTIONS.some((attribution) => attribution.test(preceding))) {
      return match.index;
    }
  }
  return -1;
}

/** Does this fragment still say anything once the tags are gone? */
function hasVisibleText(html: string): boolean {
  return (
    stripTags(html)
      .replace(/&nbsp;/gi, " ")
      .replace(/&[a-z#0-9]+;/gi, "x")
      .trim().length > 0
  );
}

export type StrippedHtml = { html: string; quotedCount: number };

/**
 * Split an HTML body into what this sender newly wrote and the thread quoted
 * beneath it. The count is of quoted MESSAGES, so the reader is told how much
 * history is under the fold rather than having it silently disappear.
 */
export function stripQuotedHtml(html: string): StrippedHtml {
  if (!html) return { html: "", quotedCount: 0 };

  let cut = announcedBlockquote(html);
  for (const opener of QUOTE_OPENERS) {
    const found = html.search(opener);
    if (found >= 0 && (cut === -1 || found < cut)) cut = found;
  }
  const divider = nextDivider(html, 0);
  if (divider && (cut === -1 || divider.index < cut)) cut = divider.index;
  if (cut === -1) return { html, quotedCount: 0 };

  const head = html.slice(0, cut);
  const tail = html.slice(cut);
  // The deepest single marker, not the sum of all of them: Gmail writes both a
  // wrapper and an "On … wrote:" line for one quoted message, and adding those
  // together says two where the reader can see one.
  const quotedCount = QUOTE_COUNTERS.reduce(
    (deepest, counter) => Math.max(deepest, tail.match(counter)?.length ?? 0),
    countDividers(tail),
  );

  // A top-posted reply is all head; a bare forward is all tail. Never blank a
  // message to prove a point about quoting.
  if (!hasVisibleText(head)) return { html, quotedCount: 0 };

  return { html: head, quotedCount: Math.max(1, quotedCount) };
}

/**
 * Turn the blockquotes that survived the fold into plain blocks.
 *
 * Whatever is left in the fresh body is a blockquote no client announced as a
 * quote: Zoho's per-send wrapper, a template's indent. Rendered as quotes they
 * come out dimmed and pushed right once per level, and seven levels deep on a
 * phone is the message greyed out against the edge of the screen.
 */
function unwrapLayoutBlockquotes(html: string): string {
  return replaceOpeningTags(html, /<blockquote\b/i, "<div>").replace(
    /<\/blockquote\s*>/gi,
    "</div>",
  );
}

/** The readable body of one message: new text only, structure kept, theme safe. */
export function readableHtml(html: string | null | undefined): StrippedHtml {
  if (!html) return { html: "", quotedCount: 0 };
  const stripped = stripQuotedHtml(html);
  const safe = sanitizeStructuralHtml(unwrapLayoutBlockquotes(stripped.html));
  if (!hasVisibleText(safe)) return { html: "", quotedCount: stripped.quotedCount };
  return { html: safe, quotedCount: stripped.quotedCount };
}
