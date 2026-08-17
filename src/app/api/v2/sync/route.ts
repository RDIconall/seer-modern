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
