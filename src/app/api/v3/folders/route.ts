import { NextResponse } from "next/server";
import { getActiveV2Account } from "@/lib/v2/session";
import { providerFor } from "@/lib/v2/providers/provider";
import { refuseCrossSiteRequest } from "@/lib/security/same-origin";

export const dynamic = "force-dynamic";

export async function GET() {
  const refused = await refuseCrossSiteRequest();
  if (refused) return refused;
  const account = await getActiveV2Account();
  if (!account) {
    return NextResponse.json({ error: "no active v2 account" }, { status: 404 });
  }
  const folders = await (await providerFor(account)).listFolders();
  return NextResponse.json({ folders });
}
