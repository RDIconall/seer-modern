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
 * A state-changing request sent by the app's own pages: a POST whose
 * Origin matches this deployment and whose Sec-Fetch-Site, when the
 * browser sends one, is same-origin. Session cookies ride along on
 * top-level cross-site GET navigations (SameSite=Lax), so a GET never
 * qualifies, however it was triggered.
 */
export function requestFromApp(request: Request): boolean {
  console.log("DBG", request.method, request.url, request.headers.get("origin"), request.headers.get("sec-fetch-site"));
  if (request.method !== "POST") return false;
  const site = request.headers.get("sec-fetch-site");
  if (site !== null && site !== "same-origin") return false;
  return originAllowed({
    origin: request.headers.get("origin"),
    requestOrigin: new URL(request.url).origin,
    allowedOrigin: process.env.SEER_ALLOWED_ORIGIN,
    production: process.env.NODE_ENV === "production",
  });
}
