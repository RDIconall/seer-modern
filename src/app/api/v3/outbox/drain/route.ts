import { NextResponse } from "next/server";
import { listAllAccounts } from "@/lib/v2/db/list-accounts";
import { providerFor } from "@/lib/v2/providers/provider";
import { drainOutbox } from "@/lib/v3/outbox/drain";
import { getActiveV2Account } from "@/lib/v2/session";
import { originAllowed } from "@/lib/security/origin";
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

/**
 * Drain the signed-in user's own queue, now.
 *
 * The cron is a backstop, not the mechanism: on the five-minute tick a batch of
 * deletes trickles out to the provider long after the user watched the rows
 * leave the screen, and mail they cleared is still sitting in Outlook. The
 * client calls this once per batch so the queue empties while they are still
 * looking at it. It is the user's own account only, so it needs their session
 * rather than the cron secret.
 */
export async function POST(request: Request) {
  if (
    !originAllowed({
      origin: request.headers.get("origin"),
      requestOrigin: new URL(request.url).origin,
      allowedOrigin: process.env.SEER_ALLOWED_ORIGIN,
      production: process.env.NODE_ENV === "production",
    })
  ) {
    return NextResponse.json({ error: "invalid request origin" }, { status: 403 });
  }

  const account = await getActiveV2Account();
  if (!account) {
    return NextResponse.json({ error: "no active v2 account" }, { status: 404 });
  }

  try {
    const provider = await providerFor(account);
    const report = await drainOutbox(account.id, provider);
    return NextResponse.json({ ok: true, report });
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message.slice(0, 160) : "drain failed" },
      { status: 503 },
    );
  }
}
