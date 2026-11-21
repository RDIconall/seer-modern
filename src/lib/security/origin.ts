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
 * Same-origin protection for credentialed browser reads.
 *
 * Browsers omit Origin on same-origin GETs, so an absent Origin passes only
 * when Sec-Fetch-Site says the request came from this origin. A cross-site
 * link or navigation is refused even though it carries the session cookie.
 */
export function readOriginAllowed(input: {
  origin: string | null;
  fetchSite: string | null;
  requestOrigin: string;
  allowedOrigin?: string;
  production: boolean;
}): boolean {
  if (input.fetchSite && input.fetchSite !== "same-origin") return false;
  if (input.origin) return originAllowed(input);
  if (input.fetchSite === "same-origin") return true;
  return !input.production;
}
