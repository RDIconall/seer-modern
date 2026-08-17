import { NextResponse } from "next/server";
import { getActiveV2Account } from "@/lib/v2/session";
import { providerFor } from "@/lib/v2/providers/provider";
import { searchWithMetadata } from "@/lib/v3/search/repository";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * Provider search joined with stored decision/matter metadata. Unsynced hits
 * are returned as transient rows for the client to open via provider id.
 */
export async function GET(request: Request) {
  const account = await getActiveV2Account();
  if (!account) {
    return NextResponse.json({ error: "no active v2 account" }, { status: 404 });
  }

  const { searchParams } = new URL(request.url);
  const query = searchParams.get("q")?.trim() ?? "";
  if (!query) {
    return NextResponse.json({ error: "q is required" }, { status: 400 });
  }
  const cursor = searchParams.get("cursor");

  const provider = await providerFor(account);
  const view = await searchWithMetadata(account.id, provider, query, cursor);
  return NextResponse.json({ view });
}
