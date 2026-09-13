import type { AccountId } from "@/lib/v2/db/types";
import { ProviderHttpError } from "@/lib/v2/providers/http";
import {
  GmailProvider,
  type GmailHistorySync,
} from "@/lib/v2/providers/gmail";
import type { SyncContext } from "@/lib/v2/providers/types";
import {
  getPushSubscription,
  upsertPushSubscription,
} from "@/lib/v2/push/repository";
import { syncFolder } from "./engine";
import {
  removeConversationFolderMembership,
  writeConversationPage,
} from "./repository";

export type GmailWakeSyncReport =
  | {
      mode: "history";
      stored: number;
      removed: string[];
      historyId: string;
    }
  | {
      mode: "head";
      pages: number;
      complete: boolean;
      polledHead: boolean;
      historyId: string;
      fallbackReason: "missing" | "expired";
    };

type GmailHistoryResult =
  | { status: "missing" | "expired" }
  | {
      status: "applied";
      stored: number;
      removed: string[];
      historyId: string;
    };

async function applyHistoryPage(
  accountId: AccountId,
  page: GmailHistorySync,
): Promise<GmailHistoryResult> {
  const write = await writeConversationPage(
    accountId,
    "inbox",
    page.conversations,
    page.deletedConversationIds,
  );
  if (write.failed > 0) {
    throw new Error(
      `Gmail history persistence failed for ${write.failed} conversation(s)`,
    );
  }
  await removeConversationFolderMembership(
    accountId,
    "inbox",
    page.removedConversationIds,
  );
  await upsertPushSubscription(accountId, "google", {
    gmailHistoryId: page.historyId,
    lastError: null,
  });
  return {
    status: "applied",
    stored: write.stored,
    removed: [
      ...page.removedConversationIds,
      ...page.deletedConversationIds,
    ],
    historyId: page.historyId,
  };
}

async function syncGmailHistory(
  accountId: AccountId,
  provider: GmailProvider,
  context?: SyncContext,
): Promise<GmailHistoryResult> {
  const cursor = (await getPushSubscription(accountId))?.gmailHistoryId;
  if (!cursor) return { status: "missing" };

  try {
    return applyHistoryPage(
      accountId,
      await provider.syncHistory(cursor, context),
    );
  } catch (error) {
    if (error instanceof ProviderHttpError && error.status === 404) {
      return { status: "expired" };
    }
    throw error;
  }
}

export async function syncGmailOnWake(
  accountId: AccountId,
  provider: GmailProvider,
  context?: SyncContext,
): Promise<GmailWakeSyncReport> {
  const history = await syncGmailHistory(accountId, provider, context);
  if (history.status === "applied") {
    return {
      mode: "history",
      stored: history.stored,
      removed: history.removed,
      historyId: history.historyId,
    };
  }

  const head = await syncFolder(accountId, provider, "inbox", "incremental", {
    maxPages: 1,
    deadlineMs: context?.deadlineMs,
    signal: context?.signal,
  });
  const historyId = await provider.currentHistoryId(context);
  await upsertPushSubscription(accountId, "google", {
    gmailHistoryId: historyId,
    lastError: null,
  });
  return {
    mode: "head",
    pages: head.pages,
    complete: head.complete,
    polledHead: head.polledHead,
    historyId,
    fallbackReason: history.status,
  };
}
