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
 */

import { stripTags } from "@/lib/v2/intelligence/html-text";

/** Elements that carry meaning. Anything else is unwrapped, keeping its text. */
const ALLOWED_TAGS = new Set([
  "a", "b", "blockquote", "br", "caption", "code", "col", "colgroup", "dd",
  "div", "dl", "dt", "em", "figure", "figcaption", "h1", "h2", "h3", "h4",
  "h5", "h6", "hr", "i", "img", "li", "ol", "p", "pre", "s", "small", "span",
  "strong", "sub", "sup", "table", "tbody", "td", "tfoot", "th", "thead",
  "tr", "u", "ul",
]);

/**
 * Bodies are sender-controlled, so every pass below is one forward scan. A
 * pattern like `<a\b[^>]*>` or `<style>[\s\S]*?</style>` rescans the rest of
 * the body at every opener that never closes, and a body of nothing but
 * openers then freezes the reader.
 */

/** Openers of elements whose CONTENT is not message text and must go with them. */
const VOID_CONTENT_OPEN =
  /<(script|style|head|noscript|iframe|object|embed|template|form|svg|math|title)\b/gi;

const ORPHAN_DANGEROUS_OPEN =
  /<\/?(script|style|head|noscript|iframe|object|embed|template|form|svg|math|title|link|meta|base|input|button|select|textarea)\b/gi;

const DOCTYPE_OPEN = /<!DOCTYPE/gi;

const TAG_OPEN = /<(\/?)([a-zA-Z][a-zA-Z0-9]*)\b/g;

const BLOCKQUOTE_OPEN = /<blockquote\b/gi;

const ATTRIBUTE =
  /(?<![-a-zA-Z0-9_:.])([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*("([^"]*)"|'([^']*)'|([^\s"'>]+))/g;

/**
 * `html.replace(/OPEN[^>]*>/g, …)` for an `opener` regex (global, no ">" in
 * its matches). `render` gets the opener match and the text up to the ">".
 * Once an opener has no ">" after it, no later opener does either.
 */
function replaceTags(
  html: string,
  opener: RegExp,
  render: (open: RegExpExecArray, rest: string) => string,
): string {
  const out: string[] = [];
  let i = 0;
  opener.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = opener.exec(html)) !== null) {
    const afterOpen = match.index + match[0].length;
    const gt = html.indexOf(">", afterOpen);
    if (gt === -1) break;
    out.push(html.slice(i, match.index), render(match, html.slice(afterOpen, gt)));
    i = gt + 1;
    opener.lastIndex = i;
  }
  out.push(html.slice(i));
  return out.join("");
}

/** `html.replace(/START[\s\S]*?END/g, replacement)` for literal delimiters. */
function replaceDelimited(
  html: string,
  start: string,
  end: string,
  replacement: string,
): string {
  const out: string[] = [];
  let i = 0;
  while (i < html.length) {
    const open = html.indexOf(start, i);
    if (open === -1) break;
    const close = html.indexOf(end, open + start.length);
    if (close === -1) break;
    out.push(html.slice(i, open), replacement);
    i = close + end.length;
  }
  out.push(html.slice(i));
  return out.join("");
}

/**
 * Drop each void-content element with everything up to its closing tag, as
 * `/<(script|…)\b[^>]*>[\s\S]*?<\/\1\s*>/gi` would. An element with no
 * closing tag stays for the orphan pass; once one has none, no later element
 * of that name does either.
 */
function dropVoidContent(html: string): string {
  const out: string[] = [];
  const closers = new Map<string, RegExp | null>();
  let i = 0;
  VOID_CONTENT_OPEN.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = VOID_CONTENT_OPEN.exec(html)) !== null) {
    const name = match[1].toLowerCase();
    let closer = closers.get(name);
    if (closer === null) continue;
    const gt = html.indexOf(">", match.index + match[0].length);
    if (gt === -1) break;
    if (!closer) {
      closer = new RegExp(`</${name}\\s*>`, "gi");
      closers.set(name, closer);
    }
    closer.lastIndex = gt + 1;
    const close = closer.exec(html);
    if (!close) {
      closers.set(name, null);
      continue;
    }
    out.push(html.slice(i, match.index), " ");
    i = close.index + close[0].length;
    VOID_CONTENT_OPEN.lastIndex = i;
  }
  out.push(html.slice(i));
  return out.join("");
}

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
  let match: RegExpExecArray | null;
  ATTRIBUTE.lastIndex = 0;
  while ((match = ATTRIBUTE.exec(raw)) !== null) {
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
  let out = replaceDelimited(html, "<!--", "-->", "");
  out = replaceTags(out, DOCTYPE_OPEN, () => "");
  out = replaceDelimited(out, "<?", "?>", "");
  out = dropVoidContent(out);
  out = replaceTags(out, ORPHAN_DANGEROUS_OPEN, () => " ");
  out = replaceTags(out, TAG_OPEN, (open, rest) => {
    const close = open[1];
    const tag = open[2].toLowerCase();
    if (!ALLOWED_TAGS.has(tag)) return "";
    if (close) return `</${tag}>`;
    const selfClose = rest.endsWith("/");
    const attrs = selfClose ? rest.slice(0, -1) : rest;
    if (tag === "br" || tag === "hr" || tag === "img" || tag === "col") {
      return `<${tag}${rebuildAttributes(tag, attrs)} />`;
    }
    return `<${tag}${rebuildAttributes(tag, attrs)}${selfClose ? " /" : ""}>`;
  });
  return out.replace(/(?<!\s)\s*(?:<br\s*\/>\s*){3,}/gi, "<br /><br />").trim();
}

/**
 * A quote marker. `open` finds where one can start; when `at` is set it is
 * the full `<tag[^>]*…` pattern, tried sticky at each start.
 */
type Marker = { open: RegExp; at: RegExp | null };

const tagMarker = (tag: string, at: RegExp): Marker => ({
  open: new RegExp(`<${tag}`, "gi"),
  at,
});

/**
 * The first match of `marker` at or after `from`, as `String.search` would
 * find it. A failed `<tag[^>]*…` start means every later start before the
 * next ">" fails too, since its `[^>]*` sees a suffix of the same text, so
 * those are skipped rather than rescanned.
 */
function findMarker(
  html: string,
  marker: Marker,
  from: number,
): { index: number; end: number } | null {
  marker.open.lastIndex = from;
  let start: RegExpExecArray | null;
  while ((start = marker.open.exec(html)) !== null) {
    if (!marker.at) {
      return { index: start.index, end: start.index + start[0].length };
    }
    marker.at.lastIndex = start.index;
    const hit = marker.at.exec(html);
    if (hit) return { index: start.index, end: start.index + hit[0].length };
    const gt = html.indexOf(">", start.index);
    if (gt === -1) return null;
    marker.open.lastIndex = gt + 1;
  }
  return null;
}

function countMarker(html: string, marker: Marker): number {
  let count = 0;
  let from = 0;
  let hit: { index: number; end: number } | null;
  while ((hit = findMarker(html, marker, from)) !== null) {
    count += 1;
    from = hit.end > hit.index ? hit.end : hit.index + 1;
  }
  return count;
}

const APPEND_ON_SEND = tagMarker("div", /<div[^>]*id=["']?appendonsend["']?/iy);
const RPLY_FWD_MSG = tagMarker("div", /<div[^>]*id=["']?divRplyFwdMsg["']?/iy);
const GMAIL_QUOTE = tagMarker("div", /<div[^>]*class=["'][^"']*gmail_quote/iy);
const MOZ_CITE_PREFIX = tagMarker("div", /<div[^>]*class=["'][^"']*moz-cite-prefix/iy);
const YAHOO_QUOTED = tagMarker("div", /<div[^>]*(?:id|class)=["'][^"']*yahoo_quoted/iy);
const BLOCKQUOTE_CITE = tagMarker("blockquote", /<blockquote[^>]*type=["']?cite/iy);
const BLOCKQUOTE_QUOTE_CLASS = tagMarker(
  "blockquote",
  /<blockquote[^>]*class=["'][^"']*(?:gmail_quote|moz-cite|yahoo_quoted)/iy,
);
const ORIGINAL_MESSAGE: Marker = {
  open: /(?<!-)-{2,}\s*Original Message\s*-{2,}/gi,
  at: null,
};
const WROTE: Marker = { open: /\bwrote:/gi, at: null };

/**
 * Where the quoted history starts, in the shapes the clients write it. Outlook
 * opens with an `appendonsend` anchor or a `divRplyFwdMsg` header block; Gmail,
 * Thunderbird and Yahoo each name their own wrapper; and any client may write
 * an "Original Message" divider.
 */
const QUOTE_OPENERS: Marker[] = [
  APPEND_ON_SEND,
  RPLY_FWD_MSG,
  GMAIL_QUOTE,
  MOZ_CITE_PREFIX,
  YAHOO_QUOTED,
  BLOCKQUOTE_CITE,
  BLOCKQUOTE_QUOTE_CLASS,
  ORIGINAL_MESSAGE,
];

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
const QUOTE_COUNTERS: Marker[] = [
  RPLY_FWD_MSG,
  GMAIL_QUOTE,
  BLOCKQUOTE_CITE,
  ORIGINAL_MESSAGE,
  WROTE,
];

/** The last of the text a reader would see before `index`, tags removed. */
function textBefore(html: string, index: number): string {
  // Runs once per blockquote, so the slice is stripped in one pass.
  return stripTags(html.slice(Math.max(0, index - 600), index))
    .replace(/<>/g, " ")
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
    const found = findMarker(html, opener, 0)?.index ?? -1;
    if (found >= 0 && (cut === -1 || found < cut)) cut = found;
  }
  if (cut === -1) return { html, quotedCount: 0 };

  const head = html.slice(0, cut);
  const tail = html.slice(cut);
  // The deepest single marker, not the sum of all of them: Gmail writes both a
  // wrapper and an "On … wrote:" line for one quoted message, and adding those
  // together says two where the reader can see one.
  const quotedCount = QUOTE_COUNTERS.reduce(
    (deepest, counter) => Math.max(deepest, countMarker(tail, counter)),
    0,
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
  return replaceTags(html, BLOCKQUOTE_OPEN, () => "<div>").replace(
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
