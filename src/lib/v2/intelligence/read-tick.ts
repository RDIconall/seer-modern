import type { MailAccount } from "../db/accounts";
import { listAccountsForRead } from "../db/list-accounts";
import { fileMatters } from "./file-matters";
import { seedFunctions } from "./functions";
import type { ReaderModel } from "./reader";
import { readBatch, type ReadBatchResult } from "./read-batch";

/**
 * One cron tick of chief-of-staff reads across every mailbox. A single large
 * backlog used to consume the whole 250s deadline, so a quieter desk stayed
 * "Seer reading N" indefinitely. Each account now gets a bounded slice, and
 * the desk that has gone longest without a model call goes first.
 */

export const READ_TICK_SHARED_LIMIT = 120;
export const READ_TICK_MIN_PER_ACCOUNT = 16;
export const READ_TICK_CONCURRENCY = 6;

export type ReadTickReport = {
  email: string;
  attempted?: number;
  decided?: number;
  failed?: number;
  filing?: unknown;
  error?: string;
  skipped?: string;
};

export function perAccountReadLimit(accountCount: number): number {
  if (accountCount <= 0) return READ_TICK_MIN_PER_ACCOUNT;
  return Math.max(
    READ_TICK_MIN_PER_ACCOUNT,
    Math.ceil(READ_TICK_SHARED_LIMIT / accountCount),
  );
}

export async function runReadTick(options: {
  deadlineMs: number;
  model: ReaderModel;
  accounts?: MailAccount[];
  perAccountLimit?: number;
  concurrency?: number;
}): Promise<ReadTickReport[]> {
  const accounts = options.accounts ?? (await listAccountsForRead());
  const limit = options.perAccountLimit ?? perAccountReadLimit(accounts.length);
  const concurrency = options.concurrency ?? READ_TICK_CONCURRENCY;
  const report: ReadTickReport[] = [];

  for (const account of accounts) {
    if (Date.now() >= options.deadlineMs) {
      report.push({ email: account.email, skipped: "time budget" });
      continue;
    }
    try {
      const result: ReadBatchResult = await readBatch(
        account.id,
        account.email,
        options.model,
        { limit, concurrency, deadlineMs: options.deadlineMs },
      );
      await seedFunctions(account.id);
      let filing: Awaited<ReturnType<typeof fileMatters>> | { error: string };
      try {
        filing = await fileMatters(account.id, { limit });
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
  return report;
}
