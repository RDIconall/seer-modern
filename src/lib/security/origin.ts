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
 * True when the browser reports a GET as started by another site (a link, a
 * redirect, an embedded resource). Browsers do not send Origin on same-origin
 * GETs, so expensive reads that must stay GET use Fetch Metadata instead.
 * A direct navigation ("none") and non-browser clients (no header) pass.
 */
export function crossSiteRequest(headers: Headers): boolean {
  const site = headers.get("sec-fetch-site");
  return site === "cross-site" || site === "same-site";
}
