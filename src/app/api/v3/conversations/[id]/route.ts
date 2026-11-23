import { NextResponse } from "next/server";
import { getActiveV2Account } from "@/lib/v2/session";
import { getCorpusConversation } from "@/lib/v3/reader/repository";

export const dynamic = "force-dynamic";

/**
 * Corpus-backed conversation reader. Returns the newest page of the thread
 * oldest-first plus a provider deep link; `?olderThan=N` skips the N newest
 * messages to page further back. No provider credentials are exposed.
 */
export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const account = await getActiveV2Account();
  if (!account) {
    return NextResponse.json({ error: "no active v2 account" }, { status: 404 });
  }

  const rawOlderThan = new URL(request.url).searchParams.get("olderThan");
  const olderThan = rawOlderThan === null ? 0 : Number(rawOlderThan);
  if (!Number.isSafeInteger(olderThan) || olderThan < 0) {
    return NextResponse.json({ error: "olderThan must be a non-negative integer" }, { status: 400 });
  }

  const { id } = await context.params;
  const view = await getCorpusConversation(account.id, id, account.provider, { olderThan });
  if (!view) {
    return NextResponse.json({ error: "conversation not found" }, { status: 404 });
  }

  return NextResponse.json({
    conversation: view.conversation,
    nativeUrl: view.nativeUrl,
    provider: account.provider,
    // The reader separates the external trunk from the internal branches, which
    // it cannot do without knowing which side of the thread is home.
    ownEmail: account.email,
  });
}
