import { NextResponse, after } from "next/server";
import { cronUnauthorized } from "@/lib/v2/cron/auth";
import { kickNextHop, shouldContinueSync } from "@/lib/v2/cron/continue";
import { fanOutPerAccount } from "@/lib/v2/cron/fan-out";
import {
  claimWorkerLease,
  releaseWorkerLease,
} from "@/lib/v2/cron/lease";
import { listAllAccounts } from "@/lib/v2/db/list-accounts";
import { asAccountId, isUuid } from "@/lib/v2/db/types";
import { providerFor } from "@/lib/v2/providers/provider";
import {
  activeSyncFolders,
  syncAccountFolders,
} from "@/lib/v2/sync/report";
import { getAccountById } from "@/lib/v2/sync/wake-account";
import { drainOutbox } from "@/lib/v3/outbox/drain";
import type { MailAccount } from "@/lib/v2/db/accounts";
import type { SyncMode } from "@/lib/v2/sync/engine";

export const maxDuration = 300;

const SYNC_TICK_MS = 250_000;

/**
 * Authenticated v2 sync. The schedule hits this URL once; with no accountId
 * it starts one worker per mailbox. Each worker owns the full tick — outbox,
 * push repair, and folder sync — so one large backfill cannot stall another
 * desk. Auth is mandatory in production.
 */
export async function GET(request: Request) {
  const denied = cronUnauthorized(request);
  if (denied) return denied;

  const url = new URL(request.url);
  const mode: SyncMode =
    url.searchParams.get("mode") === "full" ? "full" : "incremental";
  const rawId = url.searchParams.get("accountId");
  const deadlineMs = Date.now() + SYNC_TICK_MS;

  if (rawId) {
    if (!isUuid(rawId)) {
      return NextResponse.json({ error: "invalid account id" }, { status: 400 });
    }
    const account = await getAccountById(asAccountId(rawId));
    if (!account) {
      return NextResponse.json({ error: "account not found" }, { status: 404 });
    }
    const held = await claimWorkerLease(account.id, "sync");
    if (!held) {
      return NextResponse.json({
        ok: true,
        mode,
        continued: false,
        report: [{ email: account.email, skipped: "lease" }],
      });
    }
    try {
      const report = await syncOneAccount(account, mode, deadlineMs);
      const continued = shouldContinueSync(report);
      if (continued) {
        const auth = request.headers.get("authorization");
        after(() => kickNextHop(request.url, auth));
      }
      return NextResponse.json({ ok: true, mode, continued, report });
    } finally {
      await releaseWorkerLease(account.id, "sync");
    }
  }

  const accounts = await listAllAccounts();
  const pipes = await fanOutPerAccount({
    accounts,
    path: "/api/v2/sync",
    searchParams: mode === "full" ? { mode: "full" } : {},
    authorization: request.headers.get("authorization"),
    runLocal: async (accountId) => {
      const account = accounts.find((item) => item.id === accountId);
      if (!account) throw new Error("account not found");
      return syncOneAccount(account, mode, Date.now() + SYNC_TICK_MS);
    },
  });

  return NextResponse.json({
    ok: pipes.every((pipe) => pipe.ok),
    mode,
    pipes: pipes.length,
    report: pipes,
  });
}

async function syncOneAccount(
  account: MailAccount,
  mode: SyncMode,
  deadlineMs: number,
): Promise<Record<string, unknown>[]> {
  const report: Record<string, unknown>[] = [];
  let provider;
  try {
    provider = await providerFor(account);
  } catch (e) {
    return [
      {
        email: account.email,
        error: e instanceof Error ? e.message.slice(0, 160) : "sync failed",
      },
    ];
  }

  const outbox = await drainOutbox(account.id, provider);
  report.push({ email: account.email, outbox });

  if (process.env.AUTH_URL && account.status === "active") {
    try {
      const { getPushSubscription } = await import("@/lib/v2/push/repository");
      const { ensurePushForAccount } = await import("@/lib/v2/push/ensure");
      const existing = await getPushSubscription(account.id);
      const needs =
        !existing ||
        (account.provider === "microsoft" && !existing.graphSubscriptionId) ||
        (account.provider === "google" &&
          !existing.gmailWatchExpiresAt &&
          Boolean(process.env.GMAIL_PUBSUB_TOPIC));
      if (needs) {
        await ensurePushForAccount(account);
        report.push({ email: account.email, push: "enrolled" });
      }
    } catch (e) {
      report.push({
        email: account.email,
        pushError:
          e instanceof Error ? e.message.slice(0, 120) : "push failed",
      });
    }
  }

  report.push(
    ...(await syncAccountFolders(
      account,
      provider,
      mode,
      activeSyncFolders(),
      { deadlineMs },
    )),
  );
  return report;
}
