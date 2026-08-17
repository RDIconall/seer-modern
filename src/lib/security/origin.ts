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
