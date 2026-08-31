import { NextResponse } from "next/server";
import { getActiveV2Account } from "@/lib/v2/session";
import { refreshMailboxInference } from "@/lib/v2/intelligence/mailbox-style-store";

export const dynamic = "force-dynamic";

/**
 * Hypothesis + confirmed style for this mailbox. GET refreshes inference but
 * does not overwrite a confirmed style.
 */
export async function GET() {
  const account = await getActiveV2Account();
  if (!account) {
    return NextResponse.json({ error: "no active account" }, { status: 404 });
  }
  const style = await refreshMailboxInference(account.id);
  return NextResponse.json({
    clearHabit: style.clearHabit,
    importanceCues: style.importanceCues,
    matterBar: style.matterBar,
    confirmed: style.confirmed,
    inferred: style.inferred,
    driftPrompt: style.driftPrompt,
    snapshot: style.snapshot,
    confirmedAt: style.confirmedAt,
  });
}
