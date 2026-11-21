import { headers } from "next/headers";
import { NextResponse } from "next/server";
import { sameOriginRequest } from "./origin";

type HeaderReader = Pick<Headers, "get">;

function firstValue(value: string | null): string | null {
  return value?.split(",")[0]?.trim() || null;
}

function sameOrigin(source: HeaderReader, requestOrigin: string): boolean {
  return sameOriginRequest({
    origin: source.get("origin"),
    fetchSite: source.get("sec-fetch-site"),
    requestOrigin,
    allowedOrigin: process.env.SEER_ALLOWED_ORIGIN,
    production: process.env.NODE_ENV === "production",
  });
}

/**
 * Refuse a request the app's own pages did not make before it touches the
 * mailbox session. Returns the 403 to send, or null to continue.
 */
export function refuseCrossSiteRequest(request: Request): NextResponse | null {
  if (sameOrigin(request.headers, new URL(request.url).origin)) return null;
  return NextResponse.json({ error: "invalid request origin" }, { status: 403 });
}

/**
 * The same check for code that has no Request in hand, such as the session
 * helpers. Next fills in x-forwarded-host and x-forwarded-proto on every
 * request, so they name the origin the browser addressed.
 */
export async function currentRequestIsSameOrigin(): Promise<boolean> {
  const current = await headers();
  const host =
    firstValue(current.get("x-forwarded-host")) ?? firstValue(current.get("host"));
  const proto = firstValue(current.get("x-forwarded-proto")) ?? "https";
  return sameOrigin(current, host ? `${proto}://${host}` : "");
}
