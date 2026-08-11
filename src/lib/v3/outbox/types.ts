/**
 * Write-behind outbox types. Every mutation command carries the pre-patch
 * corpus snapshot so undo and failure paths can revert exactly.
 */

export type OutboxMutationKind = "archive" | "trash" | "restore" | "markUnread";

export type CorpusSnapshot = {
  folders: string[];
  isUnread: boolean;
};

export type OutboxCommand = {
  type: OutboxMutationKind;
  conversationId: string;
  previous: CorpusSnapshot;
};

export type OutboxStatus =
  | "pending"
  | "inflight"
  | "done"
  | "failed"
  | "cancelled";

export type OutboxItem = {
  id: string;
  accountId: string;
  command: OutboxCommand;
  idempotencyKey: string;
  status: OutboxStatus;
  attempts: number;
  lastError: string | null;
  nextAttemptAt: string;
  createdAt: string;
  updatedAt: string;
};

export type DrainReport = {
  processed: number;
  done: number;
  failed: number;
  retried: number;
};
