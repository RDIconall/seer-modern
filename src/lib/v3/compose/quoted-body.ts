import createDOMPurify, { type DOMPurify, type WindowLike } from "dompurify";
import { JSDOM } from "jsdom";
import { addEmailLinkHook, EMAIL_HTML_CONFIG } from "@/lib/inbox/sanitize-policy";
import { escapeHtml } from "./quoted-thread";

/**
 * A quoted body made safe to paste into an outbound forward.
 *
 * The compose pane shows each quoted message in its own sandboxed frame, so
 * nothing in it can reach the note above. The forward that goes on the wire is
 * one HTML document with no frames: the recipient's client parses the note and
 * every quoted body together. So each body is parsed on its own, sanitized with
 * the preview's policy, and serialized back as a balanced fragment that cannot
 * close the quote it is placed in. On top of that policy, anything that can
 * paint outside the body's own box is dropped — style sheets, SVG, top-layer
 * elements, and inline CSS that positions, transforms or pulls content back.
 *
 * Server only: it needs a DOM, and jsdom does not belong in a client bundle.
 */

const OUTBOUND_FORBID_TAGS = [
  "style",
  "svg",
  "math",
  "dialog",
  "template",
  "form",
  "input",
  "button",
  "select",
  "option",
  "optgroup",
  "textarea",
  "datalist",
];

const OUTBOUND_FORBID_ATTR = [
  "popover",
  "popovertarget",
  "popovertargetaction",
  "command",
  "commandfor",
];

/** Presentation that stays inside the element's own flow position. */
const CONTAINED_STYLE = new Set([
  "color",
  "background-color",
  "font",
  "font-family",
  "font-size",
  "font-style",
  "font-variant",
  "font-weight",
  "line-height",
  "letter-spacing",
  "word-spacing",
  "text-align",
  "text-decoration",
  "text-decoration-line",
  "text-decoration-color",
  "text-decoration-style",
  "text-indent",
  "text-transform",
  "white-space",
  "word-break",
  "word-wrap",
  "overflow-wrap",
  "vertical-align",
  "list-style-type",
  "list-style-position",
  "display",
  "float",
  "clear",
  "width",
  "min-width",
  "max-width",
  "height",
  "min-height",
  "max-height",
  "margin",
  "margin-top",
  "margin-right",
  "margin-bottom",
  "margin-left",
  "padding",
  "padding-top",
  "padding-right",
  "padding-bottom",
  "padding-left",
  "border",
  "border-width",
  "border-style",
  "border-color",
  ...["top", "right", "bottom", "left"].flatMap((side) => [
    `border-${side}`,
    `border-${side}-width`,
    `border-${side}-style`,
    `border-${side}-color`,
  ]),
  "border-collapse",
  "border-spacing",
  "border-radius",
  "table-layout",
]);

/** A length here would lift the box out of its line. */
const VERTICAL_ALIGN = /^(?:baseline|sub|super|text-top|text-bottom|middle|top|bottom)$/;

function containedDeclaration(name: string, value: string): boolean {
  if (!CONTAINED_STYLE.has(name)) return false;
  const v = value.trim().toLowerCase();
  if (name === "vertical-align") return VERTICAL_ALIGN.test(v);
  const plain = v.replace(/\b(?:rgba?|hsla?)\([\d\s.,%/]*\)/g, "0");
  // No other functions (url, calc, var…), escapes, or declaration separators.
  if (!/^[\w\s#%.,"'/+-]*$/.test(plain)) return false;
  // Negative offsets pull content back over what precedes it.
  return !/(?:^|[\s,/])-[\d.]/.test(plain);
}

let purifier: { purify: DOMPurify; document: Document } | null = null;

function outboundPurifier(): { purify: DOMPurify; document: Document } {
  if (purifier) return purifier;
  const { window } = new JSDOM("");
  const purify = createDOMPurify(window as unknown as WindowLike);
  addEmailLinkHook(purify);
  const kept = window.document.createElement("span").style;
  purify.addHook("afterSanitizeAttributes", (node) => {
    if (!node.hasAttribute("style")) return;
    const style = (node as HTMLElement).style;
    kept.cssText = "";
    if (style) {
      for (let i = 0; i < style.length; i++) {
        const name = style.item(i);
        const value = style.getPropertyValue(name);
        if (containedDeclaration(name, value)) kept.setProperty(name, value);
      }
    }
    if (kept.cssText) node.setAttribute("style", kept.cssText);
    else node.removeAttribute("style");
  });
  purifier = { purify, document: window.document };
  return purifier;
}

export function sanitizeQuotedHtml(html: string): string {
  if (!html) return "";
  const { purify, document } = outboundPurifier();
  const clean = purify.sanitize(html, {
    ...EMAIL_HTML_CONFIG,
    FORBID_TAGS: OUTBOUND_FORBID_TAGS,
    FORBID_ATTR: OUTBOUND_FORBID_ATTR,
  });
  // The fragment is pasted inside a <div>; if it would not parse back to the
  // same tree there, send its text instead of markup that might not stay put.
  const probe = document.createElement("div");
  probe.innerHTML = clean;
  if (probe.innerHTML !== clean) {
    return `<pre>${escapeHtml(probe.textContent ?? "")}</pre>`;
  }
  return clean;
}
