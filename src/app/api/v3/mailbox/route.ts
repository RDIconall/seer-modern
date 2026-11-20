import { after, NextResponse } from "next/server";
import { originAllowed } from "@/lib/security/origin";
import { getActiveV2Account } from "@/lib/v2/session";
import { kickInboxCatchUp } from "@/lib/v2/sync/catch-up";
import { parseMailboxLimit } from "@/lib/v3/mailbox/limit";
import { getMailboxView } from "@/lib/v3/mailbox/repository";
import type { MailboxFolder, MailboxSort } from "@/lib/v3/mailbox/types";

const FOLDERS = new Set<MailboxFolder>(["inbox", "sent", "trash"]);
const SORTS = new Set<MailboxSort>(["date", "triage", "focus"]);

export const dynamic = "force-dynamic";

function requestOriginAllowed(request: Request): boolean {
  return originAllowed({
    origin: request.headers.get("origin"),
    requestOrigin: new URL(request.url).origin,
    allowedOrigin: process.env.SEER_ALLOWED_ORIGIN,
    production: process.env.NODE_ENV === "production",
  });
}

/**
 * Corpus-backed mailbox list for inbox, sent, and trash. Rows carry Seer
 * decision metadata where a current decision exists. This is a pure read: a
 * cross-site navigation carries the SameSite=Lax session cookie, so a GET must
 * never spend the mailbox's provider quota or write to the corpus.
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

/**
 * Kick a provider catch-up when the inbox corpus is stale, so signing in after
 * being away cannot leave last week's mail on screen. The signed-in client
 * calls this before reading the first Inbox page.
 */
export async function POST(request: Request) {
  if (!requestOriginAllowed(request)) {
    return NextResponse.json({ error: "invalid request origin" }, { status: 403 });
  }
  const account = await getActiveV2Account();
  if (!account) {
    return NextResponse.json({ error: "no active v2 account" }, { status: 404 });
  }

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
  return NextResponse.json({ catchingUp });
}
