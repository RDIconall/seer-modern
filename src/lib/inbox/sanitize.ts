"use client";

import DOMPurify from "dompurify";
import { addEmailLinkHook, EMAIL_HTML_CONFIG } from "./sanitize-policy";

let hooked = false;

export function sanitizeEmailHtml(html: string): string {
  if (!html) return "";
  if (!hooked) {
    addEmailLinkHook(DOMPurify);
    hooked = true;
  }
  return DOMPurify.sanitize(html, EMAIL_HTML_CONFIG);
}
