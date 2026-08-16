import { NextResponse } from "next/server";
import { getActiveV2Account } from "@/lib/v2/session";
import { suggestContacts } from "@/lib/v3/contacts/repository";

export const dynamic = "force-dynamic";

/**
 * Corpus-backed recipient suggestions for compose. Empty `q` returns the
 * top-ranked contacts for the active account (freshly-focused To field).
 */
export async function GET(request: Request) {
  const account = await getActiveV2Account();
  if (!account) {
    return NextResponse.json({ error: "no active v2 account" }, { status: 404 });
  }

  const q = new URL(request.url).searchParams.get("q") ?? "";
  const suggestions = await suggestContacts(account.id, q);
  return NextResponse.json({ suggestions });
}
