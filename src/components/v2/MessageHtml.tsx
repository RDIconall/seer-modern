"use client";

import * as React from "react";
import { useMemo } from "react";
import { sanitizeEmailHtml } from "@/lib/inbox/sanitize";

/**
 * Renders a message body faithfully but safely. HTML is sanitized (links open
 * in a new tab, scripts stripped); plain text is shown as-is in a readable
 * block. The message content is never trusted raw.
 */
export function MessageHtml({
  html,
  text,
}: {
  html: string | null;
  text: string | null;
}) {
  const safe = useMemo(() => (html ? sanitizeEmailHtml(html) : null), [html]);
  if (safe) {
    return (
      <div
        className="seer-message-body"
        dangerouslySetInnerHTML={{ __html: safe }}
      />
    );
  }
  return <pre className="seer-message-text">{text ?? ""}</pre>;
}
