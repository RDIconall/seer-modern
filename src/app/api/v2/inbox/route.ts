import { after, NextResponse } from "next/server";
import { getActiveV2Account } from "@/lib/v2/session";
import { kickInboxCatchUp } from "@/lib/v2/sync/catch-up";
import { buildInboxView } from "@/lib/v2/view/build";

export const dynamic = "force-dynamic";

/**
 * The one inbox read for the v2 client. Everything the UI shows — Atlas,
 * records, safe-to-delete, undecided, worth-reading, coverage — is this single
 * server-computed projection. The client renders it and computes no placement.
 */
export async function GET() {
  const account = await getActiveV2Account();
  if (!account) {
    return NextResponse.json({ error: "no active v2 account" }, { status: 404 });
  }
  try {
    let catchingUp = false;
    try {
      catchingUp = await kickInboxCatchUp(account, (work) => {
        after(() => {
          void work();
        });
      });
    } catch (cause) {
      console.error(
        "[seer] inbox catch-up kick failed",
        account.email,
        cause instanceof Error ? cause.message : cause,
      );
    }
    const view = await buildInboxView(account.id, account.provider);
    return NextResponse.json({ view, catchingUp });
  } catch (cause) {
    // A bare 500 here reaches the user as "inbox 500", which says nothing about
    // whether the database is unreachable, a migration is missing, or a query is
    // wrong. The reason is worth more than the status code.
    return NextResponse.json(
      { error: cause instanceof Error ? cause.message : "inbox projection failed" },
      { status: 500 },
    );
  }
}
