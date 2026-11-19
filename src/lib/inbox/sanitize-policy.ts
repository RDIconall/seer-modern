import type { Config, DOMPurify } from "dompurify";

/**
 * The DOMPurify policy for message bodies, shared by the reader (browser
 * DOMPurify) and the outbound forward (DOMPurify over a server DOM) so what
 * the user previews and what goes on the wire cannot drift apart.
 */
export const EMAIL_HTML_CONFIG = { ADD_ATTR: ["target"] } satisfies Config;

/**
 * Gmail behavior for message bodies: every link opens in a NEW tab and
 * can't reach back into the window that rendered it.
 */
export function addEmailLinkHook(purify: DOMPurify): void {
  purify.addHook("afterSanitizeAttributes", (node) => {
    if (node.tagName === "A") {
      node.setAttribute("target", "_blank");
      node.setAttribute("rel", "noopener noreferrer");
    }
  });
}
