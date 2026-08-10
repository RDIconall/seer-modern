import { randomUUID } from "node:crypto";
import { db } from "../db/pool";
import type { AccountId } from "../db/types";
import type { MailProvider } from "../providers/types";
import {
  coverage,
  loadCursor,
  saveCursor,
  writeConversationPage,
  type Coverage,
} from "./repository";

/**
 * The sync engine drains provider pages into the relational corpus. It is the
 * one ingestion path for both incremental webhook-driven syncs and the initial
 * full-corpus rebuild — the difference is only the starting cursor. Coverage is
 * always reconciled against the provider's own total, and a failed page item is
 * counted, never silently dropped.
 */

export type SyncMode = "incremental" | "full";

export type SyncRun = {
  traceId: string;
  mode: SyncMode;
  coverage: Coverage;
  pages: number;
};

export async function syncAccount(
  accountId: AccountId,
  provider: MailProvider,
  mode: SyncMode,
): Promise<SyncRun> {
  const traceId = randomUUID();
  const started = new Date();

  // A full rebuild starts from the beginning; incremental resumes the cursor.
  let cursor = mode === "full" ? null : await loadCursor(accountId);
  let failed = 0;
  let pages = 0;
  let providerTotal = 0;

  // Loop until the provider reports no more pages. Each page is its own
  // transaction; the cursor is persisted only after that commit, so a crash
  // resumes cleanly without re-writing committed pages.
  for (;;) {
    const page = await provider.sync(cursor);
    providerTotal = page.providerTotal;
    const result = await writeConversationPage(
      accountId,
      page.conversations,
      page.deletedConversationIds,
    );
    failed += result.failed;
    pages++;
    await saveCursor(accountId, page.nextCursor, providerTotal);
    cursor = page.nextCursor;
    if (!cursor) break;
  }

  const cov = await coverage(accountId);
  cov.failed = failed;

  await db().query(
    `insert into seer.sync_runs
       (account_id, trace_id, mode, provider_total, stored, pending, failed, started_at, finished_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, now())`,
    [accountId, traceId, mode, cov.providerTotal, cov.stored, cov.pending, failed, started],
  );

  return { traceId, mode, coverage: cov, pages };
}
