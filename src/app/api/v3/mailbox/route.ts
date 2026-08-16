import { NextResponse } from "next/server";
import { getActiveV2Account } from "@/lib/v2/session";
import { parseMailboxLimit } from "@/lib/v3/mailbox/limit";
import { getMailboxView } from "@/lib/v3/mailbox/repository";
import type { MailboxFolder, MailboxSort } from "@/lib/v3/mailbox/types";

const FOLDERS = new Set<MailboxFolder>(["inbox", "sent", "trash"]);
const SORTS = new Set<MailboxSort>(["date", "triage"]);

export const dynamic = "force-dynamic";

/**
 * Corpus-backed mailbox list for inbox, sent, and trash. Rows carry Seer
 * decision metadata where a current decision exists.
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

  const view = await getMailboxView(account.id, folder, limit, before, sort);
  return NextResponse.json({ view });
}
