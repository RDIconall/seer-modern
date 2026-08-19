"use client";

import * as React from "react";
import { useMemo } from "react";
import { sanitizeEmailHtml } from "@/lib/inbox/sanitize";

/**
 * Digest mail often arrives as one long line of clauses separated by middle
 * dots. Split those into a list so the eye can find the newest item.
 */
export function plainBodyBlocks(text: string): string[] {
  const blocks: string[] = [];
  for (const paragraph of text.replace(/\r\n/g, "\n").split(/\n+/)) {
    const trimmed = paragraph.trim();
    if (!trimmed) continue;
    const clauses = trimmed.split(/\s·\s/);
    if (clauses.length >= 4 && trimmed.length > 80) {
      blocks.push(...clauses.map((clause) => clause.trim()).filter(Boolean));
      continue;
    }
    blocks.push(trimmed);
  }
  return blocks;
}

/**
 * Renders a message body faithfully but safely. HTML is sanitized (links open
 * in a new tab, scripts stripped); plain text is shown as readable blocks.
 * The message content is never trusted raw.
 */
export function MessageHtml({
  html,
  text,
}: {
  html: string | null;
  text: string | null;
}) {
  const safe = useMemo(() => (html ? sanitizeEmailHtml(html) : null), [html]);
  const blocks = useMemo(
    () => (text && !safe ? plainBodyBlocks(text) : []),
    [safe, text],
  );

  if (safe) {
    return (
      <div
        className="seer-message-body"
        dangerouslySetInnerHTML={{ __html: safe }}
      />
    );
  }

  if (blocks.length === 0) {
    return <pre className="seer-message-text">{text ?? ""}</pre>;
  }

  if (blocks.length === 1) {
    return <p className="seer-message-text">{blocks[0]}</p>;
  }

  // Several clauses on one line — show them as a scannable list.
  if (blocks.length >= 4 && text && text.includes(" · ")) {
    return (
      <ul className="seer-message-list">
        {blocks.map((block) => (
          <li key={block}>{block}</li>
        ))}
      </ul>
    );
  }

  return (
    <div className="seer-message-blocks">
      {blocks.map((block) => (
        <p key={block} className="seer-message-text">
          {block}
        </p>
      ))}
    </div>
  );
}
