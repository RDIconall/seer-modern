import type { MailAccount } from "../db/accounts";
import { listAccountsForRead } from "../db/list-accounts";
import { fileMatters } from "./file-matters";
import { seedFunctions } from "./functions";
import type { ReaderModel } from "./reader";
import { readBatch, type ReadBatchResult } from "./read-batch";

/**
 * One mailbox's chief-of-staff read. The cron dispatcher starts one of these
 * per inbox so desks do not share a serverless time budget.
 */

export const READ_TICK_ACCOUNT_LIMIT = 200;
export const READ_TICK_CONCURRENCY = 6;
export const READ_TICK_MS = 250_000;

export type ReadTickReport = {
  email: string;
  attempted?: number;
  decided?: number;
  failed?: number;
  filing?: unknown;
  error?: string;
  skipped?: string;
};

export async function runReadAccount(
  account: MailAccount,
  options: {
    deadlineMs: number;
    model: ReaderModel;
    perAccountLimit?: number;
    concurrency?: number;
  },
): Promise<ReadTickReport> {
  const limit = options.perAccountLimit ?? READ_TICK_ACCOUNT_LIMIT;
  const concurrency = options.concurrency ?? READ_TICK_CONCURRENCY;
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
    return { email: account.email, ...result, filing };
  } catch (e) {
    return {
      email: account.email,
      error: e instanceof Error ? e.message.slice(0, 160) : "read failed",
    };
  }
}

/**
 * In-process parallel read of many mailboxes. Production cron does not use
 * this for isolation — it HTTP-fans-out — but tests and local dev still must
 * not queue one desk behind another.
 */
export async function runReadTick(options: {
  deadlineMs: number;
  model: ReaderModel;
  accounts?: MailAccount[];
  perAccountLimit?: number;
  concurrency?: number;
}): Promise<ReadTickReport[]> {
  const accounts = options.accounts ?? (await listAccountsForRead());
  return Promise.all(
    accounts.map((account) =>
      runReadAccount(account, {
        deadlineMs: options.deadlineMs,
        model: options.model,
        perAccountLimit: options.perAccountLimit,
        concurrency: options.concurrency,
      }),
    ),
  );
}
