import { headers } from "next/headers";

/**
 * Which browser requests may act on the signed-in mailbox.
 *
 * The Auth.js session cookie is SameSite=Lax, so any site can make a signed-in
 * browser send it on a top-level GET, and a same-origin GET carries no Origin
 * header to compare. Fetch Metadata is the signal: browsers set Sec-Fetch-Site
 * and Sec-Fetch-Mode themselves, page script cannot, and a redirect chain that
 * started on another site stays "cross-site".
 *
 * - "fetch": a same-origin fetch/XHR from the app. Navigations, including
 *   same-origin ones, and requests without fetch metadata are refused.
 * - "navigation": also a same-origin navigation, for links the app renders
 *   (attachment downloads, export, OAuth start).
 * - "state-verified": no browser check. Only for OAuth returns, which arrive
 *   cross-site by design, and only after the caller matched the state cookie.
 */
export type BrowserRequestPolicy = "fetch" | "navigation" | "state-verified";

type HeaderSource = { get(name: string): string | null };

const FETCH_MODES = new Set(["cors", "same-origin", "no-cors"]);

export function browserRequestAllowed(
  source: HeaderSource,
  policy: BrowserRequestPolicy = "fetch",
): boolean {
  if (policy === "state-verified") return true;
  if (source.get("sec-fetch-site")?.toLowerCase() !== "same-origin") return false;
  if (policy === "navigation") return true;
  return FETCH_MODES.has(source.get("sec-fetch-mode")?.toLowerCase() ?? "");
}

export async function currentRequestAllowed(
  policy: BrowserRequestPolicy = "fetch",
): Promise<boolean> {
  if (policy === "state-verified") return true;
  return browserRequestAllowed(await headers(), policy);
}
