import { NextResponse } from "next/server";
import { getActiveV2Account } from "@/lib/v2/session";
import { providerFor } from "@/lib/v2/providers/provider";

export const dynamic = "force-dynamic";

export async function GET() {
  const account = await getActiveV2Account();
  if (!account) {
    return NextResponse.json({ error: "no active v2 account" }, { status: 404 });
  }
  const folders = await (await providerFor(account)).listFolders();
  return NextResponse.json({ folders });
}
