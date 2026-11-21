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
 * Strict same-origin test for a cookie-authenticated GET that does expensive
 * or state-replacing work. A cross-site top-level navigation carries the
 * SameSite=Lax session cookie but no Origin header, so a missing Origin is
 * never enough on its own: the request must either name the app as its
 * Origin or carry the browser-set `Sec-Fetch-Site: same-origin`. Any other
 * Fetch Metadata value (cross-site, same-site, none) is refused.
 */
export function strictSameOrigin(input: {
  origin: string | null;
  secFetchSite: string | null;
  requestOrigin: string;
  allowedOrigin?: string;
}): boolean {
  if (input.secFetchSite !== null && input.secFetchSite !== "same-origin") {
    return false;
  }
  if (input.origin === null) return input.secFetchSite === "same-origin";
  return originAllowed({
    origin: input.origin,
    requestOrigin: input.requestOrigin,
    allowedOrigin: input.allowedOrigin,
    production: true,
  });
}
