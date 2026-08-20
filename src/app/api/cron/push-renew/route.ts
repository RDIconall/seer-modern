import { NextResponse } from "next/server";
import { listAllAccounts } from "@/lib/v2/db/list-accounts";
import { listPushNeedingRenewal } from "@/lib/v2/push/repository";
import { ensurePushForAccount } from "@/lib/v2/push/ensure";
import { getAccountById } from "@/lib/v2/sync/wake-account";

export const maxDuration = 300;

/** Renew watches / Graph subscriptions that expire within 48 hours. */
const RENEW_WITHIN_MS = 48 * 60 * 60 * 1000;

export async function GET(request: Request) {
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

  const needing = await listPushNeedingRenewal(RENEW_WITHIN_MS);
  const report: Record<string, unknown>[] = [];

  // Also register for active accounts that have never been enrolled.
  const accounts = await listAllAccounts();
  const known = new Set(needing.map((p) => p.accountId));
  for (const account of accounts) {
    if (account.status !== "active") continue;
    if (!known.has(account.id)) {
      needing.push({
        accountId: account.id,
        provider: account.provider,
        gmailHistoryId: null,
        gmailWatchExpiresAt: null,
        graphSubscriptionId: null,
        graphClientStateHash: null,
        graphExpiresAt: null,
        lastNotificationAt: null,
        lastWakeAt: null,
        lastError: null,
      });
    }
  }

  for (const push of needing) {
    const account = await getAccountById(push.accountId);
    if (!account || account.status !== "active") {
      report.push({ accountId: push.accountId, skipped: "inactive" });
      continue;
    }
    try {
      await ensurePushForAccount(account);
      report.push({ email: account.email, renewed: true });
    } catch (e) {
      report.push({
        email: account.email,
        error: e instanceof Error ? e.message.slice(0, 160) : "renew failed",
      });
    }
  }

  return NextResponse.json({ ok: true, report });
}
