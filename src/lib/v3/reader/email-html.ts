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
 * Every pass reads the body through the linear scanner in `@/lib/html/scan`;
 * a regular expression that searches for a tag's `>` can be made to rescan
 * the rest of a sender-controlled body once per `<`.
 */

import {
  capHtml,
  htmlTokens,
  isSpace,
  parseAttributes,
  stripTags,
  type HtmlToken,
} from "../../html/scan";

/** Elements that carry meaning. Anything else is unwrapped, keeping its text. */
const ALLOWED_TAGS = new Set([
  "a", "b", "blockquote", "br", "caption", "code", "col", "colgroup", "dd",
  "div", "dl", "dt", "em", "figure", "figcaption", "h1", "h2", "h3", "h4",
  "h5", "h6", "hr", "i", "img", "li", "ol", "p", "pre", "s", "small", "span",
  "strong", "sub", "sup", "table", "tbody", "td", "tfoot", "th", "thead",
  "tr", "u", "ul",
]);

/** Elements whose CONTENT is not message text and must go with them. */
const VOID_CONTENT = new Set([
  "script", "style", "head", "noscript", "iframe", "object", "embed",
  "template", "form", "svg", "math", "title",
]);

/** The same elements, plus the ones that act without content, as lone tags. */
const ORPHAN_DANGEROUS = new Set([
  ...VOID_CONTENT,
  "link", "meta", "base", "input", "button", "select", "textarea",
]);

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
  for (const [name, value] of parseAttributes(raw)) {
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
  const out: string[] = [];
  for (const token of htmlTokens(html, VOID_CONTENT)) {
    if (token.kind === "text") {
      // A `<` that opened nothing stays text, so it must not open a tag later.
      out.push(html.slice(token.start, token.end).replace(/</g, "&lt;"));
      continue;
    }
    if (token.kind === "dropped") {
      out.push(" ");
      continue;
    }
    if (token.kind !== "tag") continue;
    const tag = token.name;
    if (ORPHAN_DANGEROUS.has(tag)) {
      out.push(" ");
      continue;
    }
    if (!ALLOWED_TAGS.has(tag)) continue;
    if (token.closing) {
      out.push(`</${tag}>`);
    } else if (tag === "br" || tag === "hr" || tag === "img" || tag === "col") {
      out.push(`<${tag}${rebuildAttributes(tag, token.attrs)} />`);
    } else {
      out.push(`<${tag}${rebuildAttributes(tag, token.attrs)}${token.selfClosing ? " /" : ""}>`);
    }
  }
  return collapseBreaks(out.join("")).trim();
}

const BR = "<br />";

/**
 * Three or more bare `<br />` in a row, with only whitespace around and
 * between them, become two.
 */
function collapseBreaks(html: string): string {
  const out: string[] = [];
  let emitted = 0;
  let pos = 0;
  for (;;) {
    const first = html.indexOf(BR, pos);
    if (first === -1) break;
    let runStart = first;
    while (runStart > emitted && isSpace(html.charCodeAt(runStart - 1))) runStart--;
    let count = 1;
    let afterLast = first + BR.length;
    let runEnd = afterLast;
    for (;;) {
      while (runEnd < html.length && isSpace(html.charCodeAt(runEnd))) runEnd++;
      if (!html.startsWith(BR, runEnd)) break;
      count++;
      afterLast = runEnd + BR.length;
      runEnd = afterLast;
    }
    if (count >= 3) {
      out.push(html.slice(emitted, runStart), "<br /><br />");
      emitted = runEnd;
      pos = runEnd;
    } else {
      pos = afterLast;
    }
  }
  out.push(html.slice(emitted));
  return out.join("");
}

/**
 * Where the quoted history starts, in the shapes the clients write it. Outlook
 * opens with an `appendonsend` anchor or a `divRplyFwdMsg` header block; Gmail,
 * Thunderbird and Yahoo each name their own wrapper; and any client may write
 * an "Original Message" divider.
 */
const QUOTE_OPENERS: Record<string, RegExp[]> = {
  div: [
    /id=["']?appendonsend/i,
    /id=["']?divRplyFwdMsg/i,
    /class=["'][^"']*gmail_quote/i,
    /class=["'][^"']*moz-cite-prefix/i,
    /(?:id|class)=["'][^"']*yahoo_quoted/i,
  ],
  blockquote: [
    /type=["']?cite/i,
    /class=["'][^"']*(?:gmail_quote|moz-cite|yahoo_quoted)/i,
  ],
};

type OpenTag = Extract<HtmlToken, { kind: "tag" }>;

function matchesAny(tag: OpenTag, patterns: Record<string, RegExp[]>): boolean {
  return patterns[tag.name]?.some((pattern) => pattern.test(tag.attrs)) ?? false;
}

/**
 * Every `--- Original Message ---` divider in `text` from `from` on, as
 * [start, end) pairs that do not overlap.
 */
function dividers(text: string, from = 0): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  const phrase = /original message/gi;
  phrase.lastIndex = from;
  let floor = from;
  let match: RegExpExecArray | null;
  while ((match = phrase.exec(text)) !== null) {
    let before = match.index;
    while (before > floor && isSpace(text.charCodeAt(before - 1))) before--;
    let start = before;
    while (start > floor && text.charCodeAt(start - 1) === 45) start--;
    let after = match.index + match[0].length;
    while (after < text.length && isSpace(text.charCodeAt(after))) after++;
    let end = after;
    while (end < text.length && text.charCodeAt(end) === 45) end++;
    if (before - start < 2 || end - after < 2) continue;
    out.push([start, end]);
    floor = end;
    phrase.lastIndex = end;
  }
  return out;
}

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
  /\bbegin forwarded message:\s*$/i,
  /\bfrom:[\s\S]{0,300}?\b(?:sent|date|to):[\s\S]{0,300}$/i,
];

/** Real threads announce their quote within the first few blockquotes. */
const MAX_BLOCKQUOTES_JUDGED = 100;

function isAttribution(text: string): boolean {
  if (ATTRIBUTIONS.some((attribution) => attribution.test(text))) return true;
  const last = dividers(text).at(-1);
  return last !== undefined && text.slice(last[1]).trim() === "";
}

/** Tags that each open one more quoted message, for the hidden count. */
const QUOTE_COUNTERS: Record<string, RegExp[]> = {
  div: [/id=["']?divRplyFwdMsg/i, /class=["'][^"']*gmail_quote/i],
  blockquote: [/type=["']?cite/i],
};

/** The last of the text a reader would see before `index`, tags removed. */
function textBefore(html: string, index: number): string {
  return stripTags(html.slice(Math.max(0, index - 600), index))
    .replace(/&nbsp;/gi, " ")
    .replace(/&[a-z#0-9]+;/gi, " ")
    .replace(/\s+/g, " ")
    .trimEnd()
    .slice(-300);
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

  const tags: OpenTag[] = [];
  for (const token of htmlTokens(html)) {
    if (token.kind === "tag" && !token.closing) tags.push(token);
  }

  let cut = dividers(html)[0]?.[0] ?? -1;
  let judged = 0;
  for (const tag of tags) {
    if (cut !== -1 && tag.start >= cut) break;
    // Each judgement reads a window of the body, so a body made of nothing
    // but blockquotes must not get one per tag.
    const announced =
      tag.name === "blockquote" &&
      judged++ < MAX_BLOCKQUOTES_JUDGED &&
      isAttribution(textBefore(html, tag.start));
    if (announced || matchesAny(tag, QUOTE_OPENERS)) {
      cut = tag.start;
      break;
    }
  }
  if (cut === -1) return { html, quotedCount: 0 };

  const head = html.slice(0, cut);
  // The deepest single marker, not the sum of all of them: Gmail writes both a
  // wrapper and an "On … wrote:" line for one quoted message, and adding those
  // together says two where the reader can see one.
  const markerCounts = [
    ...Object.entries(QUOTE_COUNTERS).flatMap(([name, patterns]) =>
      patterns.map(
        (pattern) =>
          tags.filter((tag) => tag.start >= cut && tag.name === name && pattern.test(tag.attrs))
            .length,
      ),
    ),
    dividers(html, cut).length,
    html.slice(cut).match(/\bwrote:/gi)?.length ?? 0,
  ];
  const quotedCount = Math.max(0, ...markerCounts);

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
  const out: string[] = [];
  for (const token of htmlTokens(html)) {
    if (token.kind === "tag" && token.name === "blockquote") {
      out.push(token.closing ? "</div>" : "<div>");
    } else {
      out.push(html.slice(token.start, token.end));
    }
  }
  return out.join("");
}

/** The readable body of one message: new text only, structure kept, theme safe. */
export function readableHtml(html: string | null | undefined): StrippedHtml {
  if (!html) return { html: "", quotedCount: 0 };
  const stripped = stripQuotedHtml(capHtml(html));
  const safe = sanitizeStructuralHtml(unwrapLayoutBlockquotes(stripped.html));
  if (!hasVisibleText(safe)) return { html: "", quotedCount: stripped.quotedCount };
  return { html: safe, quotedCount: stripped.quotedCount };
}
