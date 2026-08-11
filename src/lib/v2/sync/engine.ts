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

export type SyncRun = {
  traceId: string;
  mode: SyncMode;
  folder: SyncFolder;
  coverage: Coverage;
  pages: number;
};

export async function syncFolder(
  accountId: AccountId,
  provider: MailProvider,
  folder: SyncFolder,
  mode: SyncMode,
): Promise<SyncRun> {
  const traceId = randomUUID();
  const started = new Date();

  let cursor = mode === "full" ? null : await loadFolderCursor(accountId, folder);
  let failed = 0;
  let pages = 0;
  let providerTotal = 0;

  for (;;) {
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

  const cov = await folderCoverage(accountId, folder);
  cov.failed = failed;

  await db().query(
    `insert into seer.sync_runs
       (account_id, trace_id, mode, provider_total, stored, pending, failed, started_at, finished_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, now())`,
    [accountId, traceId, mode, cov.providerTotal, cov.stored, cov.pending, failed, started],
  );

  return { traceId, mode, folder, coverage: cov, pages };
}

/** Legacy inbox-only entry point; retained for existing callers and tests. */
export async function syncAccount(
  accountId: AccountId,
  provider: MailProvider,
  mode: SyncMode,
): Promise<SyncRun> {
  return syncFolder(accountId, provider, "inbox", mode);
}
