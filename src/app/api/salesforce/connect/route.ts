import { requireMailSession } from "@/lib/mail/session";
import { loadApp } from "@/lib/store/salesforce-auth";
import { randomBytes, createHash } from "node:crypto";
import { NextResponse } from "next/server";

/**
 * Start "Log in with Salesforce": the OAuth 2.0 web server flow with
 * PKCE. The verifier stays in an httpOnly cookie and never leaves this
 * origin; Salesforce only ever sees its SHA-256 hash, so the redirect
 * that comes back is worthless to anyone who intercepts it.
 */
export async function GET(req: Request) {
  const session = await requireMailSession();
  if (!session) {
    return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  }
  const origin = new URL(req.url).origin;
  // Come back to the app the user actually started from
  const referer = req.headers.get("referer");
  const returnTo =
    referer && new URL(referer, origin).pathname.startsWith("/m") ? "/m" : "/";

  const app = await loadApp(session.email);
  if (!app) {
    return NextResponse.redirect(
      new URL(`${returnTo}?settings=1&sf=no-app`, origin),
    );
  }

  const verifier = randomBytes(48).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const state = randomBytes(16).toString("base64url");
  const redirectUri = `${origin}/api/salesforce/callback`;

  const authorize = new URL(
    `${app.loginUrl.replace(/\/$/, "")}/services/oauth2/authorize`,
  );
  authorize.searchParams.set("response_type", "code");
  authorize.searchParams.set("client_id", app.clientId);
  authorize.searchParams.set("redirect_uri", redirectUri);
  // refresh_token is what lets the background sync run with nobody here
  authorize.searchParams.set("scope", "api refresh_token");
  authorize.searchParams.set("code_challenge", challenge);
  authorize.searchParams.set("code_challenge_method", "S256");
  authorize.searchParams.set("state", state);

  const res = NextResponse.redirect(authorize);
  const cookie = {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax" as const,
    path: "/",
    maxAge: 600,
  };
  res.cookies.set("sf_verifier", verifier, cookie);
  res.cookies.set("sf_state", state, cookie);
  res.cookies.set("sf_return", returnTo, cookie);
  return res;
}
