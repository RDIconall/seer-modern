import { NextResponse } from "next/server";
import { listAllAccounts } from "@/lib/v2/db/list-accounts";
import { providerFor } from "@/lib/v2/providers/provider";
import { drainOutbox } from "@/lib/v3/outbox/drain";
import type { AccountId } from "@/lib/v2/db/types";

export const maxDuration = 300;

/**
 * Drain pending outbox mutations against the provider. Authenticated with
 * CRON_SECRET in production — same contract as the v2 sync cron.
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

  const limit = Number(new URL(request.url).searchParams.get("limit") ?? "10");
  const accounts = await listAllAccounts();
  const report: Record<string, unknown>[] = [];

  for (const account of accounts) {
    try {
      const provider = await providerFor(account);
      const drain = await drainOutbox(account.id as AccountId, provider, {
        limit: Number.isFinite(limit) && limit > 0 ? limit : 10,
      });
      report.push({ email: account.email, ...drain });
    } catch (e) {
      report.push({
        email: account.email,
        error: e instanceof Error ? e.message.slice(0, 160) : "drain failed",
      });
    }
  }

  return NextResponse.json({ ok: true, report });
}
