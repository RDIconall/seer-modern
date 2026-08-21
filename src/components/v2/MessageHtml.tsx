"use client";

import * as React from "react";
import { useMemo, useState } from "react";
import { sanitizeEmailHtml } from "@/lib/inbox/sanitize";
import {
  hasRemoteImages,
  restoreRemoteImages,
  stripRemoteImages,
} from "@/lib/v3/reader/remote-images";

const FRAME_STYLE = `
  :root { color-scheme: light dark; }
  html, body { margin: 0; padding: 0; background: transparent; color: inherit; }
  body { overflow-wrap: anywhere; font: 14px/1.55 system-ui, sans-serif; }
  img { max-width: 100%; height: auto; }
  pre { white-space: pre-wrap; }
  a { color: #4263eb; }
`;

function frameDocument(body: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="referrer" content="no-referrer"><base target="_blank"><style>${FRAME_STYLE}</style></head><body>${body}</body></html>`;
}

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
  const [showRemote, setShowRemote] = useState(false);
  const safe = useMemo(() => (html ? sanitizeEmailHtml(html) : null), [html]);
  const blocked = useMemo(() => (safe ? stripRemoteImages(safe) : null), [safe]);
  const containsRemote = blocked ? hasRemoteImages(blocked) : false;
  const document = blocked
    ? frameDocument(showRemote ? restoreRemoteImages(blocked) : blocked)
    : null;
  if (document) {
    return (
      <div className="seer-message-body">
        {containsRemote && !showRemote ? (
          <button
            type="button"
            className="mail-remote-images mail-focus-ring"
            onClick={() => setShowRemote(true)}
          >
            Show remote images
          </button>
        ) : null}
        <iframe
          className="seer-message-frame"
          title="Email message"
          sandbox="allow-popups allow-popups-to-escape-sandbox"
          referrerPolicy="no-referrer"
          srcDoc={document}
        />
      </div>
    );
  }
  return <pre className="seer-message-text">{text ?? ""}</pre>;
}
