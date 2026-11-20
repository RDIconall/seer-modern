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
 * Same-origin protection for signed-in GETs that read the mailbox from the
 * provider, start a sync, or call the model.
 *
 * The session cookie is SameSite=Lax, so a cross-site link or top-level
 * navigation still arrives signed in, and a GET usually carries no Origin.
 * Fetch Metadata names who started the request: only the app's own pages
 * ("same-origin") may run these reads. A request without it is rejected in
 * production, like a missing Origin above; a supplied Origin is always checked.
 */
export function fetchSiteAllowed(input: {
  fetchSite: string | null;
  origin: string | null;
  requestOrigin: string;
  allowedOrigin?: string;
  production: boolean;
}): boolean {
  if (input.origin && !originAllowed({ ...input, production: true })) {
    return false;
  }
  if (!input.fetchSite) return !input.production;
  return input.fetchSite === "same-origin";
}

export function readRequestAllowed(request: Request): boolean {
  return fetchSiteAllowed({
    fetchSite: request.headers.get("sec-fetch-site"),
    origin: request.headers.get("origin"),
    requestOrigin: new URL(request.url).origin,
    allowedOrigin: process.env.SEER_ALLOWED_ORIGIN,
    production: process.env.NODE_ENV === "production",
  });
}
