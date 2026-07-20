/**
 * Pull the ONE thing to do out of an email body: the tracking link, the
 * RSVP button, the invoice, the reschedule page. Local + free — no AI
 * call, works on every message.
 */

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

function stripTags(s: string): string {
  return s
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function extractKeyActions(
  htmlBody: string,
  triageAction?: string,
): KeyAction[] {
  if (!htmlBody) return [];
  const found: (KeyAction & { score: number })[] = [];
  const seen = new Set<string>();
  const anchorRe = /<a\b[^>]*href=["'](https?:\/\/[^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;

  let m: RegExpExecArray | null;
  let guard = 0;
  while ((m = anchorRe.exec(htmlBody)) && guard < 200) {
    guard += 1;
    const url = m[1];
    const text = stripTags(m[2]).slice(0, 80);
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
