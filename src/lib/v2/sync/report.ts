import type { MailAccount } from "../db/accounts";
import type { MailProvider, SyncFolder } from "../providers/types";
import {
  isPastSyncDeadline,
  syncFolder,
  type SyncMode,
  type SyncRun,
} from "./engine";

export type SyncFolderReport = {
  email: string;
  folder: SyncFolder;
  traceId?: string;
  error?: string;
  pages?: number;
  complete?: boolean;
  backfillComplete?: boolean;
  polledHead?: boolean;
  nextCursor?: string | null;
  providerTotal?: number;
  stored?: number;
  pending?: number;
  failed?: number;
  telemetryWarning?: string;
};

export type SyncBudgetOptions = {
  /** Max pages per folder per cron tick (fair share). */
  pagesPerFolder?: number;
  /** Absolute wall-clock deadline shared across all folders in this tick. */
  deadlineMs?: number;
  /** Stable rotation slot for account/folder ordering (e.g. cron tick index). */
  tickSlot?: number;
  /** Round-robin rounds — each admitted folder gets one page per round before any gets a second. */
  rounds?: number;
};

const DEFAULT_PAGES_PER_FOLDER = 2;
const DEFAULT_ROUNDS = 2;

function runToReport(email: string, run: SyncRun): SyncFolderReport {
  return {
    email,
    folder: run.folder,
    traceId: run.traceId,
    pages: run.pages,
    complete: run.complete,
    backfillComplete: run.backfillComplete,
    polledHead: run.polledHead,
    nextCursor: run.nextCursor,
    telemetryWarning: run.telemetryWarning,
    ...run.coverage,
  };
}

export function rotate<T>(items: readonly T[], start: number): T[] {
  if (items.length === 0) return [];
  const offset = ((start % items.length) + items.length) % items.length;
  return [...items.slice(offset), ...items.slice(0, offset)];
}

/** Five-minute cron slots — stable rotation across ticks. */
export function tickRotationSlot(tickMs = Date.now()): number {
  return Math.floor(tickMs / 300_000);
}

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
    if (isPastSyncDeadline(deadlineMs)) break;
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
      report.push(runToReport(account.email, run));
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

export type SyncAccountEntry = {
  account: MailAccount;
  provider: MailProvider;
};

/**
 * Interleaved round-robin: 2 rounds × rotated accounts × rotated folders,
 * maxPages=1 per slice so no account/folder starves another.
 */
export async function syncTickRoundRobin(
  entries: SyncAccountEntry[],
  mode: SyncMode,
  folders: SyncFolder[],
  budget: Required<Pick<SyncBudgetOptions, "deadlineMs">> &
    Pick<SyncBudgetOptions, "tickSlot" | "rounds">,
): Promise<SyncFolderReport[]> {
  const report: SyncFolderReport[] = [];
  if (entries.length === 0) return report;

  const rounds = budget.rounds ?? DEFAULT_ROUNDS;
  const tickSlot = budget.tickSlot ?? 0;
  const accountOrder = rotate(entries, tickSlot % entries.length);

  for (let round = 0; round < rounds; round++) {
    if (isPastSyncDeadline(budget.deadlineMs)) break;
    const folderOrder = rotate(folders, (tickSlot + round) % folders.length);
    for (const { account, provider } of accountOrder) {
      for (const folder of folderOrder) {
        if (isPastSyncDeadline(budget.deadlineMs)) break;
        try {
          const run = await syncFolder(account.id, provider, folder, mode, {
            maxPages: 1,
            deadlineMs: budget.deadlineMs,
          });
          report.push(runToReport(account.email, run));
        } catch (e) {
          report.push({
            email: account.email,
            folder,
            error: e instanceof Error ? e.message.slice(0, 160) : "sync failed",
          });
        }
      }
    }
  }
  return report;
}

/** Default fair page budget for production cron ticks. */
export function defaultSyncBudget(startedMs = Date.now()): SyncBudgetOptions {
  return {
    pagesPerFolder: DEFAULT_PAGES_PER_FOLDER,
    deadlineMs: startedMs + 250_000,
    tickSlot: tickRotationSlot(startedMs),
    rounds: DEFAULT_ROUNDS,
  };
}
