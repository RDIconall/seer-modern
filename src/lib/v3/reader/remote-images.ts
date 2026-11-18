/**
 * Remote content in a message body stays inert until the reader asks for it.
 *
 * Every attribute the browser would fetch from — on any element, in any form
 * (quoted, unquoted, protocol-relative, srcset candidates, CSS url()) — is moved
 * to a `data-blocked-*` twin unless it is an inline `data:` or `cid:` image.
 * Restoring moves the original values back. The message frame's
 * Content-Security-Policy is the backstop for anything this pass misses.
 *
 * This runs over DOMPurify's serialised output in the browser and over raw
 * HTML in Node, so it walks tags itself instead of leaning on the DOM.
 */

const BLOCKED = "data-blocked-";
/** Holds a `<style>` element's original text (`data-blocked-style` holds a style attribute). */
const BLOCKED_CSS = `${BLOCKED}css`;

/** Attributes that fetch on any element. */
const FETCHING = new Set([
  "src",
  "srcset",
  "imagesrcset",
  "poster",
  "background",
  "lowsrc",
  "dynsrc",
  "data",
  "codebase",
  "ping",
]);
const SRCSET = new Set(["srcset", "imagesrcset"]);
/** `href` is a link on these; elsewhere (SVG image, feImage, use, link) it is a fetch. */
const LINKS = new Set(["a", "area"]);
/** Attributes whose value is CSS that may hold url(). */
const CSS_ATTRS = new Set([
  "style",
  "fill",
  "stroke",
  "filter",
  "mask",
  "clip-path",
  "marker-start",
  "marker-mid",
  "marker-end",
  "cursor",
]);
/** HTML elements whose content is text, not markup, outside SVG and MathML. */
const LITERAL_TEXT = new Set([
  "script",
  "textarea",
  "title",
  "xmp",
  "iframe",
  "noembed",
  "noframes",
  "noscript",
  "plaintext",
]);
const FOREIGN = new Set(["svg", "math"]);

const INLINE_URL = /^[\u0000-\u0020]*(?:data|cid):/i;
const FRAGMENT_URL = /^[\u0000-\u0020]*#/;
const EMPTY_URL = /^[\u0000-\u0020]*$/;
const INLINE_SRCSET = /^[\t\n\f\r ]*(?:data|cid):\S*(?:[\t\n\f\r ]+[\d.]+[wxh])?[\t\n\f\r ]*$/i;
const CSS_URL = /url\(\s*(?:"([^"]*)"|'([^']*)'|([^"'()\s]*))\s*\)/gi;
/** Anything left after url() handling that could still load, or hide a load behind an escape. */
const CSS_STILL_LOADS = /url\s*\(|image-set|(?:^|[^\w-])image\s*\(|@import|(?:^|[^\w-])src\s*\(|\\/i;
const SPACE = /[\t\n\f\r ]/;

type Attr = { name: string; value: string | null };
type Tag = {
  name: string;
  attrs: Attr[];
  selfClosing: boolean;
  /** Content of a `<style>` element, up to its end tag. */
  text: string | null;
};

export function stripRemoteImages(html: string): string {
  return rewriteTags(html, (tag, foreign) => {
    let changed = false;
    const attrs: Attr[] = [];
    for (const attr of tag.attrs) {
      const name = attr.name.toLowerCase();
      if (name.startsWith(BLOCKED)) {
        changed = true;
        continue;
      }
      const blocked = blockAttr(tag.name, name, attr.value);
      if (blocked === undefined) {
        attrs.push(attr);
        continue;
      }
      changed = true;
      attrs.push({
        name: BLOCKED + name,
        value: CSS_ATTRS.has(name) ? stash(attr.value ?? "") : attr.value,
      });
      if (blocked !== null) attrs.push({ name: attr.name, value: blocked });
    }
    if (tag.text !== null) {
      // Inside SVG or MathML a <style> holds markup, not CSS, so any tag in it goes.
      const css = foreign && /</.test(tag.text) ? null : blockCss(tag.text);
      if (css !== tag.text) {
        changed = true;
        attrs.push({ name: BLOCKED_CSS, value: stash(tag.text) });
        tag.text = css ?? "";
      }
    }
    tag.attrs = attrs;
    return changed;
  });
}

export function restoreRemoteImages(html: string): string {
  return rewriteTags(html, (tag) => {
    const originals = tag.attrs.filter((attr) =>
      attr.name.toLowerCase().startsWith(BLOCKED),
    );
    if (originals.length === 0) return false;
    const restored = new Set<string>();
    const attrs: Attr[] = [];
    for (const attr of originals) {
      if (attr.name.toLowerCase() === BLOCKED_CSS) {
        if (tag.text !== null) tag.text = unstash(attr.value ?? "");
        continue;
      }
      const name = attr.name.toLowerCase().slice(BLOCKED.length);
      restored.add(name);
      attrs.push({
        name,
        value: CSS_ATTRS.has(name) ? unstash(attr.value ?? "") : attr.value,
      });
    }
    for (const attr of tag.attrs) {
      const name = attr.name.toLowerCase();
      if (!name.startsWith(BLOCKED) && !restored.has(name)) attrs.push(attr);
    }
    tag.attrs = attrs;
    return true;
  });
}

export function hasRemoteImages(html: string): boolean {
  let found = false;
  rewriteTags(html, (tag) => {
    if (tag.attrs.some((attr) => attr.name.toLowerCase().startsWith(BLOCKED))) {
      found = true;
    }
    return false;
  });
  return found;
}

/**
 * undefined: the attribute cannot load anything and stays.
 * string: replace the value with this (CSS with its remote url()s removed).
 * null: drop the attribute.
 */
function blockAttr(tag: string, name: string, raw: string | null): string | null | undefined {
  if (raw === null) return undefined;
  if (SRCSET.has(name)) {
    return EMPTY_URL.test(raw) || INLINE_SRCSET.test(raw) ? undefined : null;
  }
  if (FETCHING.has(name)) {
    return EMPTY_URL.test(raw) || INLINE_URL.test(raw) ? undefined : null;
  }
  if ((name === "href" || name === "xlink:href") && !LINKS.has(tag)) {
    return INLINE_URL.test(raw) || FRAGMENT_URL.test(raw) ? undefined : null;
  }
  if (CSS_ATTRS.has(name)) {
    const css = decodeAttr(raw);
    if (css === null) return /url|image|import|src|\\/i.test(raw) ? null : undefined;
    const blocked = blockCss(css);
    if (blocked === css) return undefined;
    return blocked === null ? null : encodeAttr(blocked);
  }
  return undefined;
}

/** CSS with every remote url() replaced by `none`, or null if it cannot be made safe piecemeal. */
function blockCss(css: string): string | null {
  const kept = css.replace(CSS_URL, (match, double, single, bare) => {
    const url: string = double ?? single ?? bare ?? "";
    return INLINE_URL.test(url) || FRAGMENT_URL.test(url) ? match : "none";
  });
  if (CSS_STILL_LOADS.test(kept.replace(CSS_URL, ""))) return null;
  return kept;
}

/**
 * Blocked CSS is kept URI-encoded so the parked copy cannot be read as CSS and
 * needs no quoting inside an attribute.
 */
function stash(value: string): string {
  return encodeURIComponent(
    value.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, "\uFFFD"),
  );
}

function unstash(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return "";
  }
}

function encodeAttr(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

const NAMED: Record<string, string> = {
  amp: "&",
  quot: '"',
  apos: "'",
  lt: "<",
  gt: ">",
  nbsp: "\u00a0",
};

/** Decodes an attribute value, or returns null if it holds a reference this cannot read exactly. */
function decodeAttr(raw: string): string | null {
  let exact = true;
  const decoded = raw.replace(
    /&(?:#(\d+)|#[xX]([0-9a-fA-F]+)|([a-zA-Z][a-zA-Z0-9]*))(;?)/g,
    (match, dec: string | undefined, hex: string | undefined, named: string | undefined, semi: string) => {
      if (!semi) {
        exact = false;
        return match;
      }
      if (named !== undefined) {
        const char = NAMED[named];
        if (char === undefined) exact = false;
        return char ?? match;
      }
      const code = dec !== undefined ? Number(dec) : Number.parseInt(hex ?? "", 16);
      if (!Number.isInteger(code) || code <= 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) {
        exact = false;
        return match;
      }
      return String.fromCodePoint(code);
    },
  );
  return exact ? decoded : null;
}

function serializeAttr(attr: Attr): string {
  if (attr.value === null) return attr.name;
  const value = attr.value;
  if (!value.includes('"')) return `${attr.name}="${value}"`;
  if (!value.includes("'")) return `${attr.name}='${value}'`;
  return `${attr.name}="${value.replace(/"/g, "&quot;")}"`;
}

function serializeTag(rawName: string, tag: Tag): string {
  const attrs = tag.attrs.map((attr) => ` ${serializeAttr(attr)}`).join("");
  return `<${rawName}${attrs}${tag.selfClosing ? " /" : ""}>`;
}

/**
 * Tokenises start tags the way the HTML parser does and lets `edit` change
 * them. Comments, end tags and literal text pass through untouched; a tag cut
 * off by the end of the input is dropped, as the parser would drop it, so it
 * cannot swallow whatever the frame appends after the body.
 */
function rewriteTags(html: string, edit: (tag: Tag, foreign: boolean) => boolean): string {
  let out = "";
  let i = 0;
  let foreign = 0;
  const n = html.length;
  while (i < n) {
    const lt = html.indexOf("<", i);
    if (lt === -1) {
      out += html.slice(i);
      break;
    }
    out += html.slice(i, lt);
    i = lt;
    const next = html[i + 1] ?? "";

    if (/[a-zA-Z]/.test(next)) {
      const parsed = readTag(html, i + 1);
      if (!parsed) break;
      const name = parsed.name.toLowerCase();
      let end = parsed.end;
      let text: string | null = null;
      if (name === "style" || (foreign === 0 && LITERAL_TEXT.has(name))) {
        const close = name === "plaintext" ? -1 : findEndTag(html, name, parsed.end);
        end = close === -1 ? n : close;
        if (name === "style") text = html.slice(parsed.end, end);
      } else if (FOREIGN.has(name) && !parsed.selfClosing) {
        foreign++;
      }
      const tag: Tag = { name, attrs: parsed.attrs, selfClosing: parsed.selfClosing, text };
      if (edit(tag, foreign > 0)) {
        out += serializeTag(parsed.name, tag) + (tag.text ?? html.slice(parsed.end, end));
      } else {
        out += html.slice(i, end);
      }
      i = end;
      continue;
    }

    if (next === "/" && /[a-zA-Z]/.test(html[i + 2] ?? "")) {
      const parsed = readTag(html, i + 2);
      if (!parsed) break;
      if (FOREIGN.has(parsed.name.toLowerCase()) && foreign > 0) foreign--;
      out += html.slice(i, parsed.end);
      i = parsed.end;
      continue;
    }

    if (html.startsWith("<!--", i)) {
      const end = commentEnd(html, i);
      out += html.slice(i, end);
      i = end;
      continue;
    }

    if (foreign > 0 && html.startsWith("<![CDATA[", i)) {
      const close = html.indexOf("]]>", i + 9);
      const end = close === -1 ? n : close + 3;
      out += html.slice(i, end);
      i = end;
      continue;
    }

    if (next === "!" || next === "?" || next === "/") {
      const gt = html.indexOf(">", i + 2);
      const end = gt === -1 ? n : gt + 1;
      out += html.slice(i, end);
      i = end;
      continue;
    }

    out += "<";
    i++;
  }
  return out;
}

function readTag(
  html: string,
  from: number,
): { name: string; attrs: Attr[]; selfClosing: boolean; end: number } | null {
  const n = html.length;
  let i = from;
  while (i < n && !SPACE.test(html[i]) && html[i] !== "/" && html[i] !== ">") i++;
  const name = html.slice(from, i);
  const attrs: Attr[] = [];
  let selfClosing = false;
  while (i < n) {
    const c = html[i];
    if (SPACE.test(c)) {
      i++;
      continue;
    }
    if (c === ">") return { name, attrs, selfClosing, end: i + 1 };
    if (c === "/") {
      selfClosing = html[i + 1] === ">";
      i++;
      continue;
    }
    selfClosing = false;
    const nameStart = i;
    i++;
    while (i < n && !SPACE.test(html[i]) && html[i] !== "/" && html[i] !== ">" && html[i] !== "=") i++;
    const attrName = html.slice(nameStart, i);
    let j = i;
    while (j < n && SPACE.test(html[j])) j++;
    if (html[j] !== "=") {
      attrs.push({ name: attrName, value: null });
      i = j;
      continue;
    }
    j++;
    while (j < n && SPACE.test(html[j])) j++;
    const quote = html[j];
    if (quote === '"' || quote === "'") {
      const close = html.indexOf(quote, j + 1);
      if (close === -1) return null;
      attrs.push({ name: attrName, value: html.slice(j + 1, close) });
      i = close + 1;
    } else if (quote === ">") {
      attrs.push({ name: attrName, value: "" });
      i = j;
    } else {
      let k = j;
      while (k < n && !SPACE.test(html[k]) && html[k] !== ">") k++;
      attrs.push({ name: attrName, value: html.slice(j, k) });
      i = k;
    }
  }
  return null;
}

function findEndTag(html: string, name: string, from: number): number {
  const lower = html.toLowerCase();
  let at = from;
  for (;;) {
    const found = lower.indexOf(`</${name}`, at);
    if (found === -1) return -1;
    const after = html[found + name.length + 2] ?? "";
    if (after === "" || after === "/" || after === ">" || SPACE.test(after)) return found;
    at = found + 1;
  }
}

function commentEnd(html: string, start: number): number {
  if (html.startsWith("<!-->", start)) return start + 5;
  if (html.startsWith("<!--->", start)) return start + 6;
  const ends = [html.indexOf("-->", start + 4), html.indexOf("--!>", start + 4)]
    .filter((at) => at !== -1)
    .map((at) => at + (html.startsWith("-->", at) ? 3 : 4));
  return ends.length > 0 ? Math.min(...ends) : html.length;
}
