/**
 * Pull the ONE thing to do out of an email body: the tracking link, the
 * RSVP button, the invoice, the reschedule page. Local + free — no AI
 * call, works on every message.
 */

import { stripTags } from "@/lib/html/tags";

export type KeyAction = { label: string; url: string };

const INTENT_PATTERNS: { re: RegExp; label: string; score: number }[] = [
  { re: /complete (this|the) form|fill (out|in)|docs\.google\.com\/forms|forms\.gle|typeform\.com|jotform\.com|surveymonkey\.com|forms\.office\.com|airtable\.com\/shr/i, label: "Fill out form", score: 11 },
  { re: /calendly\.com|cal\.com\/|book (a )?(time|slot|meeting)|schedule (a )?(call|meeting|time)/i, label: "Book time", score: 10 },
  { re: /track(ing)?( (your|my))? (package|order|shipment)|track\b/i, label: "Track package", score: 10 },
  { re: /rsvp|accept invitation|join (the )?meeting/i, label: "RSVP", score: 10 },
  { re: /pay (now|bill|invoice)|make (a )?payment/i, label: "Pay", score: 10 },
  { re: /reschedul/i, label: "Reschedule", score: 9 },
  { re: /confirm (your )?(attendance|appointment|reservation|booking)/i, label: "Confirm", score: 9 },
  { re: /review (changes|request|the pull)/i, label: "Open review", score: 9 },
  { re: /sign (document|here|now)|docusign/i, label: "Sign", score: 9 },
  { re: /verify (your )?(email|account|identity)/i, label: "Verify", score: 8 },
  { re: /reset (your )?password/i, label: "Reset password", score: 8 },
  { re: /view (your )?(invoice|receipt|statement|order|booking|itinerary)/i, label: "View record", score: 7 },
  { re: /check.?in\b/i, label: "Check in", score: 7 },
  { re: /manage (your )?(subscription|booking|reservation)/i, label: "Manage", score: 6 },
  { re: /unsubscribe/i, label: "Unsubscribe", score: 4 },
];

const JUNK =
  /unsubscribe from|privacy|terms|preferences|view in browser|facebook|twitter|instagram|linkedin\.com\/share|help center|contact us|download (the )?app|app store|google play|mailto:/i;

function anchorText(s: string): string {
  return stripTags(s)
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const HREF_AT = /href=/gi;
const ANCHOR_HREF = /href=["'](https?:\/\/[^"']+)["']/iy;

/** The last quoted http(s) href in a tag's attributes, as a greedy `[^>]*` picks it. */
function lastHref(attrs: string): string | null {
  const starts = Array.from(attrs.matchAll(HREF_AT), (m) => m.index);
  for (let i = starts.length - 1; i >= 0; i--) {
    ANCHOR_HREF.lastIndex = starts[i];
    const m = ANCHOR_HREF.exec(attrs);
    if (m) return m[1];
  }
  return null;
}

/**
 * Each `<a … href="http…">text</a>`, as
 * `/<a\b[^>]*href=["'](https?:\/\/[^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi` would
 * find them, without rescanning the body at every unclosed "<a".
 */
function* anchors(html: string): Generator<{ url: string; inner: string }> {
  const opener = /<a\b/gi;
  const closer = /<\/a>/gi;
  let close: RegExpExecArray | null = null;
  let m: RegExpExecArray | null;
  while ((m = opener.exec(html)) !== null) {
    const attrsStart = m.index + m[0].length;
    const gt = html.indexOf(">", attrsStart);
    if (gt === -1) return;
    // Later openers before this ">" only see a suffix of these attributes.
    opener.lastIndex = gt + 1;
    const url = lastHref(html.slice(attrsStart, gt));
    if (!url) continue;
    if (!close || close.index <= gt) {
      closer.lastIndex = gt + 1;
      close = closer.exec(html);
      if (!close) return;
    }
    yield { url, inner: html.slice(gt + 1, close.index) };
    opener.lastIndex = close.index + close[0].length;
  }
}

export function extractKeyActions(
  htmlBody: string,
  triageAction?: string,
): KeyAction[] {
  if (!htmlBody) return [];
  const found: (KeyAction & { score: number })[] = [];
  const seen = new Set<string>();

  let guard = 0;
  for (const anchor of anchors(htmlBody)) {
    if (guard >= 200) break;
    guard += 1;
    const url = anchor.url;
    const text = anchorText(anchor.inner).slice(0, 80);
    const hay = `${text} ${url}`;
    if (!text && !/track|rsvp|pay|confirm/i.test(url)) continue;

    const isUnsub = /unsubscribe/i.test(hay);
    // Unsubscribe links only matter when that's the recommended action
    if (JUNK.test(hay) && !isUnsub) continue;
    if (
      isUnsub &&
      triageAction !== "unsubscribe" &&
      triageAction !== "review_subscription"
    ) {
      continue;
    }

    for (const p of INTENT_PATTERNS) {
      if (!p.re.test(hay)) continue;
      const key = url.split("?")[0];
      if (seen.has(key)) break;
      seen.add(key);
      found.push({
        label: text && text.length <= 40 ? text : p.label,
        url,
        score: p.score,
      });
      break;
    }
  }

  return found
    .sort((a, b) => b.score - a.score)
    .slice(0, 3)
    .map(({ label, url }) => ({ label, url }));
}
