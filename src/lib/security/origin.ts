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
 * Same-origin protection for any request that acts with the signed-in
 * mailbox, reads included. The session cookie rides along on a cross-site
 * top-level navigation, so the cookie alone does not show the app asked.
 *
 * Browsers omit Origin on same-origin GETs but always send Sec-Fetch-Site,
 * which a page cannot set. A supplied Origin is checked as above; otherwise
 * only `Sec-Fetch-Site: same-origin` passes. With neither header the request
 * is refused in production and allowed for local tools and tests.
 */
export function sameOriginRequest(input: {
  origin: string | null;
  fetchSite: string | null;
  requestOrigin: string;
  allowedOrigin?: string;
  production: boolean;
}): boolean {
  if (input.origin) return originAllowed(input);
  if (input.fetchSite) return input.fetchSite === "same-origin";
  return !input.production;
}
