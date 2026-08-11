import { randomUUID } from "node:crypto";
import type { AccountId } from "../db/types";
import {
  SyncDeadlineError,
  type MailProvider,
  type SyncFolder,
  type SyncPage,
} from "../providers/types";
import {
  beginFolderSnapshot,
  completeFolderSnapshot,
  folderCoverage,
  loadFolderSyncState,
  saveCursor,
  saveFolderSyncState,
  writeConversationPage,
  type Coverage,
  type FolderSyncState,
} from "./repository";
import { recordSyncRun } from "./sync-runs";

/**
 * The sync engine drains provider pages into the relational corpus. Provider
 * cursors are page offsets for historical backfill — not incremental history
 * tokens. After backfill completes we poll only the first page for new mail.
 */

export type SyncMode = "incremental" | "full";

export type SyncFolderOptions = {
  /** Stop after this many pages (omit for unbounded drain). */
  maxPages?: number;
  /** Absolute wall-clock deadline; stops before starting a page that would exceed it. */
  deadlineMs?: number;
  signal?: AbortSignal;
};

/** Safety margin for provider latency and per-page persistence before deadline. */
export const SYNC_PAGE_SAFETY_HEADROOM_MS = 15_000;
/** Inbox phone actions converge without restarting the large historical scan. */
export const INBOX_RECONCILIATION_INTERVAL_MS = 15 * 60 * 1000;
/** Sent and Trash are browsable history; rescan them less often than Inbox. */
export const HISTORY_RECONCILIATION_INTERVAL_MS = 6 * 60 * 60 * 1000;

export type SyncRun = {
  traceId: string;
  mode: SyncMode;
  folder: SyncFolder;
  coverage: Coverage;
  pages: number;
  /** Evidence-based: backfill finished or head poll completed — not partial/deadline. */
  complete: boolean;
  backfillComplete: boolean;
  polledHead: boolean;
  nextCursor: string | null;
  telemetryWarning?: string;
};

export function isPastSyncDeadline(deadlineMs: number | undefined): boolean {
  if (deadlineMs === undefined) return false;
  return Date.now() + SYNC_PAGE_SAFETY_HEADROOM_MS >= deadlineMs;
}

function reconciliationInterval(folder: SyncFolder): number {
  return folder === "inbox"
    ? INBOX_RECONCILIATION_INTERVAL_MS
    : HISTORY_RECONCILIATION_INTERVAL_MS;
}

function snapshotDue(folder: SyncFolder, state: FolderSyncState): boolean {
  if (!state.backfillComplete) return state.scanGeneration === 0;
  if (!state.lastReconciledAt) return true;
  return Date.now() - state.lastReconciledAt.getTime() >= reconciliationInterval(folder);
}

async function persistFolderState(
  accountId: AccountId,
  folder: SyncFolder,
  state: FolderSyncState,
): Promise<void> {
  await saveFolderSyncState(accountId, folder, state);
  if (folder === "inbox") {
    await saveCursor(
      accountId,
      state.cursor,
      state.providerTotal,
      state.backfillComplete,
    );
  }
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

  const durableState = await loadFolderSyncState(accountId, folder);
  let workingState = durableState;
  const canStartSnapshot = !isPastSyncDeadline(deadlineMs);
  const startSnapshot =
    canStartSnapshot &&
    ((mode === "full" && durableState.backfillComplete) ||
      (mode === "incremental" && snapshotDue(folder, durableState)) ||
      (!durableState.backfillComplete && durableState.scanGeneration === 0));
  if (startSnapshot) {
    workingState = await beginFolderSnapshot(accountId, folder);
  }

  const headPoll =
    mode === "incremental" &&
    durableState.backfillComplete &&
    !startSnapshot;
  const effectiveMaxPages = headPoll ? 1 : maxPages;

  let failed = 0;
  let pages = 0;
  let providerTotal = workingState.providerTotal;
  let providerCursor: string | null = headPoll ? null : workingState.cursor;
  let backfillComplete = workingState.backfillComplete;
  let polledHead = false;
  let backfillFinishedThisRun = false;

  for (;;) {
    if (effectiveMaxPages !== undefined && pages >= effectiveMaxPages) break;
    if (isPastSyncDeadline(deadlineMs)) break;

    let page: SyncPage;
    try {
      page = await provider.syncFolder(folder, providerCursor, {
        deadlineMs,
        signal: options.signal,
      });
    } catch (error) {
      if (
        error instanceof SyncDeadlineError ||
        options.signal?.aborted ||
        (error instanceof Error && /deadline|budget|aborted/i.test(error.message))
      ) {
        break;
      }
      throw error;
    }
    providerTotal = page.providerTotal;
    const result = await writeConversationPage(
      accountId,
      folder,
      page.conversations,
      headPoll ? [] : page.deletedConversationIds,
      headPoll ? undefined : workingState.scanGeneration,
    );
    failed += result.failed;
    pages++;

    if (headPoll) {
      polledHead = true;
      backfillComplete = true;
      providerCursor = null;
      await persistFolderState(accountId, folder, {
        cursor: null,
        backfillComplete: true,
        providerTotal,
        scanGeneration: workingState.scanGeneration,
        scanStartedAt: workingState.scanStartedAt,
        lastReconciledAt: workingState.lastReconciledAt,
      });
      break;
    }

    if (page.nextCursor === null) {
      backfillFinishedThisRun = true;
      backfillComplete = true;
      providerCursor = null;
      const completedState: FolderSyncState = {
        cursor: null,
        backfillComplete: true,
        providerTotal,
        scanGeneration: workingState.scanGeneration,
        scanStartedAt: workingState.scanStartedAt,
        lastReconciledAt: new Date(),
      };
      if (!headPoll) {
        await completeFolderSnapshot(
          accountId,
          folder,
          workingState.scanGeneration,
          providerTotal,
        );
      }
      await persistFolderState(accountId, folder, completedState);
      workingState = completedState;
      break;
    }

    providerCursor = page.nextCursor;
    backfillComplete = false;
    workingState = {
      cursor: page.nextCursor,
      backfillComplete: false,
      providerTotal,
      scanGeneration: workingState.scanGeneration,
      scanStartedAt: workingState.scanStartedAt,
      lastReconciledAt: workingState.lastReconciledAt,
    };
    await persistFolderState(accountId, folder, workingState);
  }

  if (pages === 0) {
    backfillComplete = workingState.backfillComplete;
    providerCursor = workingState.backfillComplete ? null : workingState.cursor;
  }

  const complete =
    pages > 0 && (polledHead || backfillFinishedThisRun);

  const cov = await folderCoverage(accountId, folder);
  cov.failed = failed;

  const telemetryWarning = await recordSyncRun({
    accountId,
    traceId,
    mode,
    folder,
    coverage: cov,
    complete,
    started,
  });

  return {
    traceId,
    mode,
    folder,
    coverage: cov,
    pages,
    complete,
    backfillComplete,
    polledHead,
    nextCursor: backfillComplete ? null : providerCursor,
    telemetryWarning,
  };
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
