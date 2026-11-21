import { NextResponse } from "next/server";
import { getActiveV2Account } from "@/lib/v2/session";
import { MAX_QUERY_CHARS, suggestContacts } from "@/lib/v3/contacts/repository";
import { readOriginAllowed } from "@/lib/security/origin";

export const dynamic = "force-dynamic";

/**
 * Corpus-backed recipient suggestions for compose. Empty `q` returns the
 * top-ranked contacts for the active account (freshly-focused To field).
 */
export async function GET(request: Request) {
  const url = new URL(request.url);
  if (
    !readOriginAllowed({
      origin: request.headers.get("origin"),
      fetchSite: request.headers.get("sec-fetch-site"),
      requestOrigin: url.origin,
      allowedOrigin: process.env.SEER_ALLOWED_ORIGIN,
      production: process.env.NODE_ENV === "production",
    })
  ) {
    return NextResponse.json({ error: "invalid request origin" }, { status: 403 });
  }

  const q = url.searchParams.get("q") ?? "";
  if (q.length > MAX_QUERY_CHARS) {
    return NextResponse.json({ error: "search is too long" }, { status: 400 });
  }

  const account = await getActiveV2Account();
  if (!account) {
    return NextResponse.json({ error: "no active v2 account" }, { status: 404 });
  }

  const suggestions = await suggestContacts(account.id, q);
  return NextResponse.json({ suggestions });
}
