import { randomUUID } from "node:crypto";
import type { AccountId } from "../db/types";
import type { MailProvider, SyncFolder } from "../providers/types";
import {
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
};

/** Safety margin for provider latency and per-page persistence before deadline. */
export const SYNC_PAGE_SAFETY_HEADROOM_MS = 15_000;

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

  if (mode === "full" && durableState.backfillComplete) {
    workingState = { ...durableState, backfillComplete: false, cursor: null };
  }

  const headPoll = mode === "incremental" && durableState.backfillComplete;
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

    const page = await provider.syncFolder(folder, providerCursor);
    providerTotal = page.providerTotal;
    const result = await writeConversationPage(
      accountId,
      folder,
      page.conversations,
      page.deletedConversationIds,
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
      });
      break;
    }

    if (page.nextCursor === null) {
      backfillFinishedThisRun = true;
      backfillComplete = true;
      providerCursor = null;
      await persistFolderState(accountId, folder, {
        cursor: null,
        backfillComplete: true,
        providerTotal,
      });
      break;
    }

    providerCursor = page.nextCursor;
    backfillComplete = false;
    await persistFolderState(accountId, folder, {
      cursor: page.nextCursor,
      backfillComplete: false,
      providerTotal,
    });
  }

  if (pages === 0) {
    backfillComplete = durableState.backfillComplete;
    providerCursor = durableState.backfillComplete ? null : durableState.cursor;
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
