/**
 * Same-origin protection for state-changing browser requests.
 *
 * In production a missing Origin is rejected because this endpoint is a
 * browser-facing account mutation. Tests and local non-browser tools may omit
 * it outside production; a supplied origin is always checked.
 */
export function originAllowed(input: {
  origin: string | null;
  requestOrigin: string;
  allowedOrigin?: string;
  production: boolean;
}): boolean {
  if (!input.origin) return !input.production;
  if (input.origin === "null") return false;
  try {
    const expected = input.allowedOrigin || input.requestOrigin;
    return new URL(input.origin).origin === new URL(expected).origin;
  } catch {
    return false;
  }
}

/**
 * Same-origin protection for requests that carry the session cookie, GETs
 * included. The session cookie is SameSite=Lax, so a cross-site top-level
 * navigation arrives with it and without an Origin header; Origin alone
 * cannot tell that navigation from the app's own fetch.
 *
 * Browsers that send Sec-Fetch-Site are judged by it alone: only
 * "same-origin" passes. "none" (typed URL, bookmark, link opened from
 * another app) and "same-site" are refused because nothing in the app
 * needs them and an outside party can cause them. Without Sec-Fetch-Site
 * the Origin header decides, and in production a request with neither is
 * refused.
 */
export function sameOriginRequest(input: {
  fetchSite: string | null;
  origin: string | null;
  host: string | null;
  allowedOrigin?: string;
  production: boolean;
}): boolean {
  if (input.fetchSite !== null) {
    return input.fetchSite.trim().toLowerCase() === "same-origin";
  }
  if (!input.origin) return !input.production;
  if (input.origin === "null") return false;
  try {
    const origin = new URL(input.origin);
    if (input.allowedOrigin) {
      return origin.origin === new URL(input.allowedOrigin).origin;
    }
    return !!input.host && origin.host === input.host.toLowerCase();
  } catch {
    return false;
  }
}
