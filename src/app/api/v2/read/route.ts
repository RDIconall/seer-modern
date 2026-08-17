import { NextResponse } from "next/server";
import { listAllAccounts } from "@/lib/v2/db/list-accounts";
import { readBatch } from "@/lib/v2/intelligence/read-batch";
import { defaultReaderModel } from "@/lib/v2/intelligence/model";
import { fileMatters } from "@/lib/v2/intelligence/file-matters";
import { seedFunctions } from "@/lib/v2/intelligence/functions";

export const maxDuration = 300;

/**
 * The read cron: turn ingested-but-unread conversations into decisions. Sync
 * ingests mail; this produces the chief-of-staff reads. Bounded per tick by a
 * deadline and read concurrently; a large backlog converges over several ticks.
 * Auth is mandatory in production.
 */
export async function GET(request: Request) {
  const secret = process.env.CRON_SECRET;
  if (secret) {
    const auth = request.headers.get("authorization");
    if (auth !== `Bearer ${secret}`) {
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }
  } else if (process.env.NODE_ENV === "production") {
    return NextResponse.json(
      { error: "CRON_SECRET is required in production" },
      { status: 500 },
    );
  }

  const deadlineMs = Date.now() + 250_000;
  const accounts = await listAllAccounts();
  const report: Record<string, unknown>[] = [];
  for (const account of accounts) {
    try {
      const result = await readBatch(account.id, account.email, defaultReaderModel, {
        limit: 200,
        concurrency: 6,
        deadlineMs,
      });

      // Reading creates matters; filing puts them on the whiteboard. It runs
      // here so a new matter reaches its section on the same tick rather than
      // sitting in "unfiled" until some later pass. A filing failure must not
      // discard the reads that just succeeded.
      await seedFunctions(account.id);
      let filing: Awaited<ReturnType<typeof fileMatters>> | { error: string };
      try {
        filing = await fileMatters(account.id, { limit: 200 });
      } catch (e) {
        filing = {
          error: e instanceof Error ? e.message.slice(0, 120) : "filing failed",
        };
      }
      report.push({ email: account.email, ...result, filing });
    } catch (e) {
      report.push({
        email: account.email,
        error: e instanceof Error ? e.message.slice(0, 160) : "read failed",
      });
    }
  }
  return NextResponse.json({ ok: true, report });
}
