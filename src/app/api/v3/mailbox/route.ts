import { after, NextResponse } from "next/server";
import { getActiveV2Account } from "@/lib/v2/session";
import { kickInboxCatchUp } from "@/lib/v2/sync/catch-up";
import { parseMailboxLimit } from "@/lib/v3/mailbox/limit";
import { getMailboxView } from "@/lib/v3/mailbox/repository";
import type { MailboxFolder, MailboxSort } from "@/lib/v3/mailbox/types";

const FOLDERS = new Set<MailboxFolder>(["inbox", "sent", "trash"]);
const SORTS = new Set<MailboxSort>(["date", "triage", "focus"]);

export const dynamic = "force-dynamic";

/**
 * Corpus-backed mailbox list for inbox, sent, and trash. Rows carry Seer
 * decision metadata where a current decision exists. The first page of Inbox
 * also kicks a provider catch-up when the corpus is stale, so signing in
 * after being away cannot leave last week's mail on screen.
 */
export async function GET(request: Request) {
  const account = await getActiveV2Account();
  if (!account) {
    return NextResponse.json({ error: "no active v2 account" }, { status: 404 });
  }

  const { searchParams } = new URL(request.url);
  const folderParam = (searchParams.get("folder") ?? "inbox") as MailboxFolder;
  const folder = FOLDERS.has(folderParam) ? folderParam : "inbox";
  const sortParam = (searchParams.get("sort") ?? "date") as MailboxSort;
  const sort = SORTS.has(sortParam) ? sortParam : "date";
  const limit = parseMailboxLimit(searchParams.get("limit"));
  const before = searchParams.get("before") ?? undefined;

  let catchingUp = false;
  if (folder === "inbox" && !before) {
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
  }

  const view = await getMailboxView(account.id, folder, limit, before, sort);
  return NextResponse.json({ view, catchingUp });
}
