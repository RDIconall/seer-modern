"use client";

import DOMPurify from "dompurify";

let hooked = false;

/**
 * Gmail behavior for message bodies: every link opens in a NEW tab and
 * can't reach back into the app window.
 */
export function sanitizeEmailHtml(html: string): string {
  if (!html) return "";
  if (!hooked) {
    DOMPurify.addHook("afterSanitizeAttributes", (node) => {
      if (node.tagName === "A") {
        node.setAttribute("target", "_blank");
        node.setAttribute("rel", "noopener noreferrer");
      }
    });
    hooked = true;
  }
  return DOMPurify.sanitize(html, { ADD_ATTR: ["target"] });
}
