import { NextResponse } from "next/server";
import { listAllAccounts } from "@/lib/v2/db/list-accounts";
import { providerFor } from "@/lib/v2/providers/provider";
import {
  activeSyncFolders,
  defaultSyncBudget,
  syncTickRoundRobin,
  type SyncAccountEntry,
} from "@/lib/v2/sync/report";
import { drainOutbox } from "@/lib/v3/outbox/drain";

export const maxDuration = 300;

/**
 * Authenticated v2 sync ingress. Reconciliation cron and manual triggers land
 * here. Auth is mandatory: in production a missing CRON_SECRET is a hard error,
 * never an open endpoint.
 */
export async function GET(request: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    if (process.env.NODE_ENV === "production") {
      return NextResponse.json(
        { error: "CRON_SECRET is required in production" },
        { status: 500 },
      );
    }
  } else {
    const auth = request.headers.get("authorization");
    if (auth !== `Bearer ${secret}`) {
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }
  }

  const mode =
    new URL(request.url).searchParams.get("mode") === "full"
      ? "full"
      : "incremental";

  const accounts = await listAllAccounts();
  const report: Record<string, unknown>[] = [];
  const tickStarted = Date.now();
  const syncBudget = defaultSyncBudget(tickStarted);
  const activeFolders = activeSyncFolders();
  const entries: SyncAccountEntry[] = [];

  for (const account of accounts) {
    let provider;
    try {
      provider = await providerFor(account);
    } catch (e) {
      report.push({
        email: account.email,
        error: e instanceof Error ? e.message.slice(0, 160) : "sync failed",
      });
      continue;
    }
    const outbox = await drainOutbox(account.id, provider);
    report.push({ email: account.email, outbox });
    entries.push({ account, provider });
  }

  // Enroll / repair push off the sync path so Outlook Graph subscriptions
  // appear without waiting for a re-login or the renewal cron alone.
  if (process.env.AUTH_URL) {
    const { getPushSubscription } = await import("@/lib/v2/push/repository");
    const { ensurePushForAccount } = await import("@/lib/v2/push/ensure");
    for (const { account } of entries) {
      if (account.status !== "active") continue;
      try {
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
          pushError: e instanceof Error ? e.message.slice(0, 120) : "push failed",
        });
      }
    }
  }

  if (entries.length > 0 && syncBudget.deadlineMs !== undefined) {
    report.push(
      ...(await syncTickRoundRobin(entries, mode, activeFolders, {
        deadlineMs: syncBudget.deadlineMs,
        tickSlot: syncBudget.tickSlot,
        rounds: syncBudget.rounds,
      })),
    );
  }

  return NextResponse.json({ ok: true, mode, report });
}
