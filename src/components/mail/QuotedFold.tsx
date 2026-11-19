"use client";

import * as React from "react";
import { MailReader } from "./MailReader";

/**
 * The fold under a message's new text. It stays in the page with the whole
 * message as received, so collapsing history never leaves the pane without a
 * copy of what was sent.
 */
export function QuotedFold({
  count,
  html,
  text,
}: {
  count: number;
  html: string | null | undefined;
  text: string;
}) {
  return (
    <details className="reader-quoted">
      <summary className="reader-stripped tabular">
        {count} quoted message{count > 1 ? "s" : ""} hidden · Show full message
      </summary>
      <MailReader html={html} text={text} />
    </details>
  );
}
