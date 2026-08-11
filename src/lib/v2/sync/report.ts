import type { MailAccount } from "../db/accounts";
import type { MailProvider, SyncFolder } from "../providers/types";
import { syncFolder, type SyncMode } from "./engine";

export type SyncFolderReport = {
  email: string;
  folder: SyncFolder;
  traceId?: string;
  error?: string;
  pages?: number;
  complete?: boolean;
  nextCursor?: string | null;
  providerTotal?: number;
  stored?: number;
  pending?: number;
  failed?: number;
};

export type SyncBudgetOptions = {
  /** Max pages per folder per cron tick (fair share). */
  pagesPerFolder?: number;
  /** Absolute wall-clock deadline shared across all folders in this tick. */
  deadlineMs?: number;
};

const DEFAULT_PAGES_PER_FOLDER = 2;

export async function syncAccountFolders(
  account: MailAccount,
  provider: MailProvider,
  mode: SyncMode,
  folders: SyncFolder[],
  budget?: SyncBudgetOptions,
): Promise<SyncFolderReport[]> {
  const report: SyncFolderReport[] = [];
  const pagesPerFolder = budget?.pagesPerFolder ?? undefined;
  const deadlineMs = budget?.deadlineMs;

  for (const folder of folders) {
    try {
      const run = await syncFolder(
        account.id,
        provider,
        folder,
        mode,
        pagesPerFolder !== undefined || deadlineMs !== undefined
          ? { maxPages: pagesPerFolder, deadlineMs }
          : {},
      );
      report.push({
        email: account.email,
        folder,
        traceId: run.traceId,
        pages: run.pages,
        complete: run.complete,
        nextCursor: run.nextCursor,
        ...run.coverage,
      });
    } catch (e) {
      report.push({
        email: account.email,
        folder,
        error: e instanceof Error ? e.message.slice(0, 160) : "sync failed",
      });
    }
  }
  return report;
}

/** Default fair page budget for production cron ticks (2 pages × 3 folders). */
export function defaultSyncBudget(startedMs = Date.now()): SyncBudgetOptions {
  return {
    pagesPerFolder: DEFAULT_PAGES_PER_FOLDER,
    // Leave headroom under the 300s route limit for outbox drain and response.
    deadlineMs: startedMs + 250_000,
  };
}
