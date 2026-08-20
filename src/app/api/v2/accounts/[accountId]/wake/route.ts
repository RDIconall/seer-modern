import { NextResponse, after } from "next/server";
import { asAccountId } from "@/lib/v2/db/types";
import { wakeAccount } from "@/lib/v2/sync/wake-account";

export const maxDuration = 300;

/**
 * Internal single-account wake. Webhooks and renewal cron call this with
 * CRON_SECRET; it must never be reachable from the browser.
 */
export async function POST(
  request: Request,
  context: { params: Promise<{ accountId: string }> },
) {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    if (process.env.NODE_ENV === "production") {
      return NextResponse.json(
        { error: "CRON_SECRET is required in production" },
        { status: 500 },
      );
    }
  } else if (request.headers.get("authorization") !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const { accountId: raw } = await context.params;
  let accountId;
  try {
    accountId = asAccountId(raw);
  } catch {
    return NextResponse.json({ error: "invalid account id" }, { status: 400 });
  }

  // Prefer background completion when the caller is a webhook that already
  // returned 200 — but this route itself may be the workhorse.
  const wait = request.headers.get("x-seer-wake-mode") === "async";
  if (wait) {
    after(async () => {
      await wakeAccount(accountId);
    });
    return NextResponse.json({ ok: true, queued: true });
  }

  const report = await wakeAccount(accountId);
  return NextResponse.json({ ok: !report.error, report });
}
