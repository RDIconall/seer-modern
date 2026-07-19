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

export function middleware(request: NextRequest) {
  if (!canonicalHost || process.env.VERCEL_ENV !== "production") {
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
