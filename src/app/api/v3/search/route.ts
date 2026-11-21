import { NextResponse } from "next/server";
import { getActiveV2Account } from "@/lib/v2/session";
import { providerFor } from "@/lib/v2/providers/provider";
import { searchWithMetadata } from "@/lib/v3/search/repository";
import { originAllowed } from "@/lib/security/origin";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const MAX_QUERY_CHARS = 500;

/**
 * Provider search joined with stored decision/matter metadata. Unsynced hits
 * are returned as transient rows for the client to open via provider id.
 *
 * Search spends the mailbox's provider quota, so it is a same-origin POST: a
 * link or cross-site page cannot make the signed-in browser run it.
 */
export async function POST(request: Request) {
  if (
    !originAllowed({
      origin: request.headers.get("origin"),
      requestOrigin: new URL(request.url).origin,
      allowedOrigin: process.env.SEER_ALLOWED_ORIGIN,
      production: process.env.NODE_ENV === "production",
    })
  ) {
    return NextResponse.json({ error: "invalid request origin" }, { status: 403 });
  }

  const account = await getActiveV2Account();
  if (!account) {
    return NextResponse.json({ error: "no active v2 account" }, { status: 404 });
  }

  const body = (await request.json().catch(() => null)) as {
    q?: unknown;
    cursor?: unknown;
  } | null;
  const query = typeof body?.q === "string" ? body.q.trim() : "";
  if (!query) {
    return NextResponse.json({ error: "q is required" }, { status: 400 });
  }
  if (query.length > MAX_QUERY_CHARS) {
    return NextResponse.json({ error: "q is too long" }, { status: 400 });
  }
  const cursor = typeof body?.cursor === "string" && body.cursor ? body.cursor : null;

  const provider = await providerFor(account);
  const view = await searchWithMetadata(account.id, provider, query, cursor);
  return NextResponse.json({ view });
}
