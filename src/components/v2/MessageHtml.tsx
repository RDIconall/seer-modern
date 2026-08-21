"use client";

import * as React from "react";
import { useEffect, useMemo, useRef, useState } from "react";
import { sanitizeEmailHtml } from "@/lib/inbox/sanitize";
import {
  hasRemoteImages,
  restoreRemoteImages,
  stripRemoteImages,
} from "@/lib/v3/reader/remote-images";

const FRAME_STYLE = `
  :root { color-scheme: light dark; }
  html { -webkit-text-size-adjust: 100%; }
  html, body { margin: 0; padding: 0; background: transparent; color: inherit; }
  body { overflow-wrap: anywhere; font: 14px/1.55 system-ui, sans-serif; }
  img, video, svg, canvas { max-width: 100%; height: auto; }
  table { max-width: 100%; }
  pre { white-space: pre-wrap; }
  a { color: #4263eb; }
`;

/**
 * Runs inside the sandbox, never in the app. Mail is written for a 600px
 * desktop column, so on a phone it either clips or grows a sideways scrollbar.
 * Cap what reflows, scale down what refuses to, then tell the app how tall the
 * result is so the message can sit in the page instead of inside a box with a
 * scrollbar of its own.
 */
const FRAME_SCRIPT = `
(function () {
  var doc = document.documentElement;
  var body = document.body;
  var last = -1;
  var busy = false;
  function fit() {
    if (busy) return;
    busy = true;
    body.style.transform = "";
    body.style.width = "";
    var available = doc.clientWidth;
    var content = Math.max(body.scrollWidth, doc.scrollWidth);
    if (available > 0 && content > available + 2) {
      var scale = available / content;
      body.style.transformOrigin = "top left";
      body.style.transform = "scale(" + scale + ")";
      body.style.width = 100 / scale + "%";
    }
    var height = Math.ceil(body.getBoundingClientRect().height);
    if (height > 0 && height !== last) {
      last = height;
      parent.postMessage({ seerFrameHeight: height }, "*");
    }
    requestAnimationFrame(function () { busy = false; });
  }
  fit();
  window.addEventListener("load", fit);
  window.addEventListener("resize", fit);
  if (window.ResizeObserver) new ResizeObserver(fit).observe(body);
  setTimeout(fit, 250);
  setTimeout(fit, 1200);
})();
`;

function frameDocument(body: string): string {
  return (
    `<!doctype html><html><head><meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width, initial-scale=1">` +
    `<meta name="referrer" content="no-referrer"><base target="_blank">` +
    `<style>${FRAME_STYLE}</style></head><body>${body}` +
    `<script>${FRAME_SCRIPT}</script></body></html>`
  );
}

/**
 * Renders a message body faithfully but safely. HTML is sanitized (links open
 * in a new tab, scripts stripped); plain text is shown as-is in a readable
 * block. The message content is never trusted raw.
 *
 * The frame is scripted so it can measure and fit itself, but it is never
 * same-origin: it cannot read the app's DOM, cookies or storage, and the only
 * thing the app accepts back from it is a number, from that frame's own window.
 */
export function MessageHtml({
  html,
  text,
}: {
  html: string | null;
  text: string | null;
}) {
  const [showRemote, setShowRemote] = useState(false);
  const [height, setHeight] = useState<number | null>(null);
  const frame = useRef<HTMLIFrameElement | null>(null);
  const safe = useMemo(() => (html ? sanitizeEmailHtml(html) : null), [html]);
  const blocked = useMemo(() => (safe ? stripRemoteImages(safe) : null), [safe]);
  const containsRemote = blocked ? hasRemoteImages(blocked) : false;
  const frameHtml = blocked
    ? frameDocument(showRemote ? restoreRemoteImages(blocked) : blocked)
    : null;

  useEffect(() => {
    setHeight(null);
  }, [frameHtml]);

  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      if (!frame.current || event.source !== frame.current.contentWindow) return;
      const reported = (event.data as { seerFrameHeight?: unknown } | null)
        ?.seerFrameHeight;
      const next = typeof reported === "number" ? reported : Number.NaN;
      // A message cannot ask for an arbitrarily tall hole in the page.
      if (Number.isFinite(next) && next > 0) setHeight(Math.min(next, 20000));
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, []);

  if (frameHtml) {
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
          ref={frame}
          className="seer-message-frame"
          title="Email message"
          sandbox="allow-popups allow-popups-to-escape-sandbox allow-scripts"
          referrerPolicy="no-referrer"
          srcDoc={frameHtml}
          style={height ? { height: `${height}px`, minHeight: 0 } : undefined}
        />
      </div>
    );
  }
  return <pre className="seer-message-text">{text ?? ""}</pre>;
}
