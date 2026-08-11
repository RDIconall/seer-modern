import { randomUUID } from "node:crypto";
import { db } from "../db/pool";
import type { AccountId } from "../db/types";
import type { MailProvider, SyncFolder } from "../providers/types";
import {
  folderCoverage,
  loadFolderCursor,
  saveCursor,
  saveFolderCursor,
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

export type SyncFolderOptions = {
  /** Stop after this many pages (omit for unbounded drain). */
  maxPages?: number;
  /** Absolute wall-clock deadline; stops before starting a page that would exceed it. */
  deadlineMs?: number;
};

/** Safety margin for provider latency and per-page persistence before deadline. */
export const SYNC_PAGE_SAFETY_HEADROOM_MS = 15_000;

export type SyncRun = {
  traceId: string;
  mode: SyncMode;
  folder: SyncFolder;
  coverage: Coverage;
  pages: number;
  complete: boolean;
  nextCursor: string | null;
};

function shouldStopBeforePage(deadlineMs: number | undefined): boolean {
  if (deadlineMs === undefined) return false;
  return Date.now() + SYNC_PAGE_SAFETY_HEADROOM_MS >= deadlineMs;
}

export async function syncFolder(
  accountId: AccountId,
  provider: MailProvider,
  folder: SyncFolder,
  mode: SyncMode,
  options: SyncFolderOptions = {},
): Promise<SyncRun> {
  const traceId = randomUUID();
  const started = new Date();
  const { maxPages, deadlineMs } = options;

  let cursor = mode === "full" ? null : await loadFolderCursor(accountId, folder);
  let failed = 0;
  let pages = 0;
  let providerTotal = 0;

  for (;;) {
    if (maxPages !== undefined && pages >= maxPages) break;
    if (shouldStopBeforePage(deadlineMs)) break;

    const page = await provider.syncFolder(folder, cursor);
    providerTotal = page.providerTotal;
    const result = await writeConversationPage(
      accountId,
      folder,
      page.conversations,
      page.deletedConversationIds,
    );
    failed += result.failed;
    pages++;
    await saveFolderCursor(accountId, folder, page.nextCursor, providerTotal);
    if (folder === "inbox") {
      await saveCursor(accountId, page.nextCursor, providerTotal);
    }
    cursor = page.nextCursor;
    if (!cursor) break;
  }

  const complete = cursor === null;
  const cov = await folderCoverage(accountId, folder);
  cov.failed = failed;

  await db().query(
    `insert into seer.sync_runs
       (account_id, trace_id, mode, folder, provider_total, stored, pending, failed, complete, started_at, finished_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, now())`,
    [
      accountId,
      traceId,
      mode,
      folder,
      cov.providerTotal,
      cov.stored,
      cov.pending,
      failed,
      complete,
      started,
    ],
  );

  return { traceId, mode, folder, coverage: cov, pages, complete, nextCursor: cursor };
}

/** Legacy inbox-only entry point; retained for existing callers and tests. */
export async function syncAccount(
  accountId: AccountId,
  provider: MailProvider,
  mode: SyncMode,
  options?: SyncFolderOptions,
): Promise<SyncRun> {
  return syncFolder(accountId, provider, "inbox", mode, options);
}
