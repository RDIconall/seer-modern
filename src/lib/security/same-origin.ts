import { headers } from "next/headers";
import { NextResponse } from "next/server";
import { sameOriginRequest } from "./origin";

/** Auth.js session cookie, with or without the secure prefix and chunk suffix. */
const SESSION_COOKIE = /^(__Secure-)?authjs\.session-token(\.\d+)?$/;

/**
 * Whether the request being handled came from this app's own pages. Reads
 * the incoming request headers, so it works in any route handler without
 * threading the Request through.
 */
export async function isSameOriginRequest(): Promise<boolean> {
  const h = await headers();
  return sameOriginRequest({
    fetchSite: h.get("sec-fetch-site"),
    origin: h.get("origin"),
    host: h.get("x-forwarded-host") ?? h.get("host"),
    allowedOrigin: process.env.SEER_ALLOWED_ORIGIN,
    production: process.env.NODE_ENV === "production",
  });
}

/**
 * A refusal for a request that did not come from this app, or null to
 * proceed. Session-backed GETs call this before any loader, because those
 * loaders spend the mailbox's provider quota and rewrite caches.
 *
 * It must not resolve the session: Auth.js' jwt callback can refresh the
 * provider token. Whether a session cookie was sent only picks the status
 * (401 without one, 403 with one); both refuse.
 */
export async function refuseCrossSiteRequest(): Promise<NextResponse | null> {
  if (await isSameOriginRequest()) return null;
  const cookieHeader = (await headers()).get("cookie") ?? "";
  const hasSessionCookie = cookieHeader
    .split(";")
    .some((part) => SESSION_COOKIE.test(part.split("=")[0]?.trim() ?? ""));
  if (!hasSessionCookie) {
    return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  }
  return NextResponse.json({ error: "invalid request origin" }, { status: 403 });
}
