import { NextResponse, after } from "next/server";
import { cronUnauthorized } from "@/lib/v2/cron/auth";
import { kickNextHop, shouldContinueRead } from "@/lib/v2/cron/continue";
import { fanOutPerAccount } from "@/lib/v2/cron/fan-out";
import {
  claimWorkerLease,
  releaseWorkerLease,
} from "@/lib/v2/cron/lease";
import { listAccountsForRead } from "@/lib/v2/db/list-accounts";
import { asAccountId, isUuid } from "@/lib/v2/db/types";
import { defaultReaderModel } from "@/lib/v2/intelligence/model";
import {
  READ_TICK_MS,
  runReadAccount,
} from "@/lib/v2/intelligence/read-tick";
import { getAccountById } from "@/lib/v2/sync/wake-account";

export const maxDuration = 300;

/**
 * Read cron. The schedule hits this URL once; with no accountId it starts one
 * worker invocation per mailbox so each inbox has its own 250s pipe. A worker
 * that still has unread mail kicks the next hop so a large desk drains today.
 */
export async function GET(request: Request) {
  const denied = cronUnauthorized(request);
  if (denied) return denied;

  const url = new URL(request.url);
  const rawId = url.searchParams.get("accountId");
  const deadlineMs = Date.now() + READ_TICK_MS;

  if (rawId) {
    if (!isUuid(rawId)) {
      return NextResponse.json({ error: "invalid account id" }, { status: 400 });
    }
    const account = await getAccountById(asAccountId(rawId));
    if (!account) {
      return NextResponse.json({ error: "account not found" }, { status: 404 });
    }
    const held = await claimWorkerLease(account.id, "read");
    if (!held) {
      return NextResponse.json({
        ok: true,
        continued: false,
        report: [{ email: account.email, skipped: "lease" }],
      });
    }
    try {
      const report = await runReadAccount(account, {
        deadlineMs,
        model: defaultReaderModel,
      });
      const continued = shouldContinueRead(report);
      if (continued) {
        const auth = request.headers.get("authorization");
        after(() => kickNextHop(request.url, auth));
      }
      return NextResponse.json({
        ok: !report.error,
        continued,
        report: [report],
      });
    } finally {
      await releaseWorkerLease(account.id, "read");
    }
  }

  const accounts = await listAccountsForRead();
  const pipes = await fanOutPerAccount({
    accounts,
    path: "/api/v2/read",
    authorization: request.headers.get("authorization"),
    runLocal: async (accountId) => {
      const account = accounts.find((item) => item.id === accountId);
      if (!account) throw new Error("account not found");
      return [
        await runReadAccount(account, {
          deadlineMs: Date.now() + READ_TICK_MS,
          model: defaultReaderModel,
        }),
      ];
    },
  });

  return NextResponse.json({
    ok: pipes.every((pipe) => pipe.ok),
    pipes: pipes.length,
    report: pipes,
  });
}
