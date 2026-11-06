import { NextResponse } from "next/server";
import { getActiveV2Account } from "@/lib/v2/session";
import { isMissingRelation } from "@/lib/v2/db/missing";
import { loadWhiteboardView } from "@/lib/v2/whiteboard/repository";
import { seedWhiteboardView } from "@/lib/v2/whiteboard/seed";

export const dynamic = "force-dynamic";

/**
 * CEO Whiteboard projection. The bot never calls this (SSO); Conall's client
 * does. Missing tables return the Oct 30 seed with persisted=false.
 */
export async function GET() {
  const account = await getActiveV2Account();
  if (!account) {
    return NextResponse.json({ error: "no active v2 account" }, { status: 404 });
  }
  try {
    const view = await loadWhiteboardView(account.id);
    return NextResponse.json({ view });
  } catch (cause) {
    if (isMissingRelation(cause)) {
      return NextResponse.json({ view: seedWhiteboardView(account.id) });
    }
    return NextResponse.json(
      {
        error:
          cause instanceof Error ? cause.message : "whiteboard projection failed",
      },
      { status: 500 },
    );
  }
}
