import { NextResponse } from "next/server";
import { getActiveV2Account } from "@/lib/v2/session";
import { asConversationId } from "@/lib/v2/db/types";
import { suggestMattersForConversation } from "@/lib/v2/intelligence/user-matter";

export const dynamic = "force-dynamic";

/** Related/open matters for the long-press picker in mobile Triage. */
export async function GET(request: Request) {
  const account = await getActiveV2Account();
  if (!account) {
    return NextResponse.json({ error: "no active v2 account" }, { status: 404 });
  }
  const conversationId = new URL(request.url).searchParams.get("conversationId");
  if (!conversationId) {
    return NextResponse.json(
      { error: "conversationId required" },
      { status: 400 },
    );
  }
  try {
    const matters = await suggestMattersForConversation(
      account.id,
      asConversationId(conversationId),
    );
    return NextResponse.json({ matters });
  } catch (cause) {
    return NextResponse.json(
      {
        error:
          cause instanceof Error ? cause.message : "matter suggestions failed",
      },
      { status: 400 },
    );
  }
}
