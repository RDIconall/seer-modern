import { NextResponse, type NextRequest } from "next/server";

/**
 * Funnel every production alias (seer-modern-rditrials.vercel.app,
 * per-deployment URLs, …) to the one canonical host in AUTH_URL.
 *
 * OAuth breaks without this: the PKCE/state cookies are set on the host
 * where you tap "Connect Gmail", but Google always redirects back to the
 * AUTH_URL host — if they differ, the cookie is missing and Auth.js
 * fails with InvalidCheck ("Server error" page).
 */
const canonicalHost = process.env.AUTH_URL
  ? new URL(process.env.AUTH_URL).host
  : null;

/**
 * Paths Vercel invokes as cron jobs. Vercel calls them on the deployment's own
 * URL, which is never the canonical host, so they MUST skip the funnel below:
 * a redirect drops the Authorization header and the job silently no-ops —
 * returning 200 while doing nothing, which looks healthy in every log.
 *
 * Must stay in sync with "crons" in vercel.json. The middleware test reads that
 * file and fails if a scheduled path is not exempt here, so adding a cron
 * without updating this list cannot ship.
 */
const CRON_PATH_PREFIXES = [
  "/api/cron/",
  "/api/v2/sync",
  "/api/v2/read",
  "/api/v3/outbox/",
];

export function isCronPath(pathname: string): boolean {
  return CRON_PATH_PREFIXES.some((p) => pathname.startsWith(p));
}

export function middleware(request: NextRequest) {
  if (!canonicalHost || process.env.VERCEL_ENV !== "production") {
    return NextResponse.next();
  }
  if (isCronPath(request.nextUrl.pathname)) {
    return NextResponse.next();
  }
  const host = request.headers.get("host");
  if (host && host !== canonicalHost) {
    const url = new URL(request.url);
    url.protocol = "https:";
    url.host = canonicalHost;
    url.port = "";
    return NextResponse.redirect(url, 308);
  }
  return NextResponse.next();
}

export const config = {
  // Everything except static assets — auth routes especially must match
  matcher: ["/((?!_next/static|_next/image|favicon\\.ico|icons/|sw\\.js).*)"],
};
