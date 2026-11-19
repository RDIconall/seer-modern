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
 * Bodies are attacker-controlled and this runs synchronously, so markup is
 * read with the linear scanner in html-scan.ts rather than with regular
 * expressions that rescan the rest of the body at every unclosed tag.
 */

import {
  isWhitespace,
  parseAttributes,
  scanHtml,
  stripTags,
  type HtmlTag,
} from "@/lib/v2/intelligence/html-scan";

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

/** Dropped wherever they appear, even without content or a closing tag. */
const DANGEROUS = new Set([
  ...VOID_CONTENT,
  "link", "meta", "base", "input", "button", "select", "textarea",
]);

const VOID_ELEMENTS = new Set(["br", "hr", "img", "col"]);

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
  for (const { name, value } of parseAttributes(raw)) {
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
  return sanitize(html, false);
}

/**
 * Three or more line breaks in a row, with the whitespace around them. The
 * lookbehind starts a match only where a whitespace run begins, so a long run
 * is not re-read from each of its characters.
 */
const BREAK_RUN = /(?<!\s)(?:\s*<br \/>){3,}\s*/g;

function rebuildTag(tag: HtmlTag, layoutBlockquotes: boolean): string {
  if (DANGEROUS.has(tag.name)) return " ";
  if (layoutBlockquotes && tag.name === "blockquote") {
    return tag.closing ? "</div>" : "<div>";
  }
  if (!ALLOWED_TAGS.has(tag.name)) return "";
  if (tag.closing) return `</${tag.name}>`;
  const attrs = rebuildAttributes(tag.name, tag.attrs);
  if (VOID_ELEMENTS.has(tag.name)) return `<${tag.name}${attrs} />`;
  return `<${tag.name}${attrs}${tag.selfClosing ? " /" : ""}>`;
}

function sanitize(html: string, layoutBlockquotes: boolean): string {
  if (!html) return "";
  const out: string[] = [];
  scanHtml(
    html,
    {
      // Only tags rebuilt here may reach the output as markup.
      text: (text) => out.push(text.replace(/</g, "&lt;")),
      tag: (tag) => out.push(rebuildTag(tag, layoutBlockquotes)),
      skipped: () => out.push(" "),
    },
    { skipContent: VOID_CONTENT },
  );
  return out.join("").replace(BREAK_RUN, "<br /><br />").trim();
}

/**
 * Where the quoted history starts, in the shapes the clients write it. Outlook
 * opens with an `appendonsend` anchor or a `divRplyFwdMsg` header block; Gmail,
 * Thunderbird and Yahoo each name their own wrapper; and any client may write
 * an "Original Message" divider. Each pattern is tested against one tag's
 * attribute text, never against the rest of the body.
 */
const DIV_OPENERS: RegExp[] = [
  /id=["']?appendonsend/i,
  /id=["']?divRplyFwdMsg/i,
  /class=["'][^"']*gmail_quote/i,
  /class=["'][^"']*moz-cite-prefix/i,
  /(?:id|class)=["'][^"']*yahoo_quoted/i,
];
const BLOCKQUOTE_OPENERS: RegExp[] = [
  /type=["']?cite/i,
  /class=["'][^"']*(?:gmail_quote|moz-cite|yahoo_quoted)/i,
];

/** Tag markers that each open one more quoted message, for the hidden count. */
const DIV_COUNTERS: RegExp[] = [/id=["']?divRplyFwdMsg/i, /class=["'][^"']*gmail_quote/i];
const BLOCKQUOTE_COUNTERS: RegExp[] = [/type=["']?cite/i];

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
  /-{2}\s*original message\s*-{2,}\s*$/i,
  /\bbegin forwarded message:\s*$/i,
];

/** "From:" followed somewhere later by a "Sent:", "Date:" or "To:" field. */
function endsWithHeaderBlock(text: string): boolean {
  const from = /\bfrom:/i.exec(text);
  if (!from) return false;
  const field = /\b(?:sent|date|to):/gi;
  field.lastIndex = from.index + from[0].length;
  return field.test(text);
}

function announcesQuote(preceding: string): boolean {
  return (
    ATTRIBUTIONS.some((attribution) => attribution.test(preceding)) ||
    endsWithHeaderBlock(preceding)
  );
}

/**
 * How many blockquotes are judged on the text above them. Each judgement reads
 * a bounded window, and a body of nothing but blockquotes must not multiply
 * that window by its length. Past this many, the remaining blockquotes are
 * left in the fresh body, which shows more of the message rather than less.
 */
const MAX_JUDGED_BLOCKQUOTES = 200;

/** The last of the text a reader would see before `index`, tags removed. */
function textBefore(html: string, index: number): string {
  return stripTags(html.slice(Math.max(0, index - 600), index))
    .replace(/&nbsp;/gi, " ")
    .replace(/&[a-z#0-9]+;/gi, " ")
    .replace(/\s+/g, " ")
    .trimEnd()
    .slice(-300);
}

const DASH = 0x2d;

/**
 * Start offsets of every `-{2,}\s*Original Message\s*-{2,}` divider, found
 * from the words outwards so a long run of dashes is walked once.
 */
function originalMessageDividers(html: string): number[] {
  const starts: number[] = [];
  const words = /original message/gi;
  let previousEnd = 0;
  let match: RegExpExecArray | null;
  while ((match = words.exec(html)) !== null) {
    let start = match.index;
    while (start > previousEnd && isWhitespace(html.charCodeAt(start - 1))) start -= 1;
    let before = 0;
    while (start > previousEnd && html.charCodeAt(start - 1) === DASH) {
      start -= 1;
      before += 1;
    }
    if (before < 2) continue;
    let end = match.index + match[0].length;
    while (end < html.length && isWhitespace(html.charCodeAt(end))) end += 1;
    let after = 0;
    while (end < html.length && html.charCodeAt(end) === DASH) {
      end += 1;
      after += 1;
    }
    if (after < 2) continue;
    starts.push(start);
    previousEnd = end;
    words.lastIndex = end;
  }
  return starts;
}

type QuoteMarkers = {
  /** The first tag that opens quoted history, or -1. */
  opener: number;
  /** Start of every opening blockquote tag, in order. */
  blockquotes: number[];
  /** Start of every tag that counts one quoted message. */
  counted: number[][];
};

function quoteMarkers(html: string): QuoteMarkers {
  const markers: QuoteMarkers = {
    opener: -1,
    blockquotes: [],
    counted: [[], [], []],
  };
  scanHtml(html, {
    tag: (tag) => {
      if (tag.closing) return;
      if (tag.name === "div") {
        if (markers.opener === -1 && DIV_OPENERS.some((p) => p.test(tag.attrs))) {
          markers.opener = tag.start;
        }
        DIV_COUNTERS.forEach((p, k) => {
          if (p.test(tag.attrs)) markers.counted[k].push(tag.start);
        });
      } else if (tag.name === "blockquote") {
        markers.blockquotes.push(tag.start);
        if (markers.opener === -1 && BLOCKQUOTE_OPENERS.some((p) => p.test(tag.attrs))) {
          markers.opener = tag.start;
        }
        if (BLOCKQUOTE_COUNTERS[0].test(tag.attrs)) markers.counted[2].push(tag.start);
      }
    },
  });
  return markers;
}

/** The first blockquote a client actually announced as a quote, if any. */
function announcedBlockquote(html: string, blockquotes: number[], before: number): number {
  const judged = blockquotes.slice(0, MAX_JUDGED_BLOCKQUOTES);
  for (const index of judged) {
    if (before !== -1 && index >= before) break;
    if (announcesQuote(textBefore(html, index))) return index;
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

const earliest = (a: number, b: number) => (a === -1 ? b : b === -1 ? a : Math.min(a, b));

/**
 * Split an HTML body into what this sender newly wrote and the thread quoted
 * beneath it. The count is of quoted MESSAGES, so the reader is told how much
 * history is under the fold rather than having it silently disappear.
 */
export function stripQuotedHtml(html: string): StrippedHtml {
  if (!html) return { html: "", quotedCount: 0 };

  const markers = quoteMarkers(html);
  const dividers = originalMessageDividers(html);
  const opened = earliest(markers.opener, dividers[0] ?? -1);
  const cut = earliest(announcedBlockquote(html, markers.blockquotes, opened), opened);
  if (cut === -1) return { html, quotedCount: 0 };

  const head = html.slice(0, cut);
  const tail = html.slice(cut);
  const inTail = (starts: number[]) => starts.filter((start) => start >= cut).length;
  // The deepest single marker, not the sum of all of them: Gmail writes both a
  // wrapper and an "On … wrote:" line for one quoted message, and adding those
  // together says two where the reader can see one.
  const quotedCount = Math.max(
    ...markers.counted.map(inTail),
    inTail(dividers),
    tail.match(/\bwrote:/gi)?.length ?? 0,
  );

  // A top-posted reply is all head; a bare forward is all tail. Never blank a
  // message to prove a point about quoting.
  if (!hasVisibleText(head)) return { html, quotedCount: 0 };

  return { html: head, quotedCount: Math.max(1, quotedCount) };
}

/** The readable body of one message: new text only, structure kept, theme safe. */
export function readableHtml(html: string | null | undefined): StrippedHtml {
  if (!html) return { html: "", quotedCount: 0 };
  const stripped = stripQuotedHtml(html);
  // Whatever blockquote is left in the fresh body is one no client announced
  // as a quote: Zoho's per-send wrapper, a template's indent. Rendered as
  // quotes they come out dimmed and pushed right once per level, so they are
  // rebuilt as plain blocks.
  const safe = sanitize(stripped.html, true);
  if (!hasVisibleText(safe)) return { html: "", quotedCount: stripped.quotedCount };
  return { html: safe, quotedCount: stripped.quotedCount };
}
