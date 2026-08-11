/**
 * Write-behind outbox types. Stored commands carry internal before/after
 * snapshots captured under row lock at enqueue time.
 */

export type OutboxMutationKind = "archive" | "trash" | "restore" | "markUnread";

export type CorpusSnapshot = {
  folders: string[];
  isUnread: boolean;
};

/** Caller-facing enqueue payload — previous/expected are captured internally. */
export type EnqueueInput = {
  type: OutboxMutationKind;
  conversationId: string;
};

/** Persisted command with internal snapshots for safe revert. */
export type OutboxCommand = {
  type: OutboxMutationKind;
  conversationId: string;
  previous: CorpusSnapshot;
  expected: CorpusSnapshot;
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
  reconcileNeeded: boolean;
  nextAttemptAt: string;
  createdAt: string;
  updatedAt: string;
};

export type DrainReport = {
  processed: number;
  done: number;
  failed: number;
  retried: number;
  reclaimed: number;
};

/** Bounded window during which a `done` outbox row may still mask stale sync. */
export const DONE_CONVERGENCE_MS = 10 * 60 * 1000;

export type SyncMask = {
  blockedFolders: Set<string>;
  /** Optimistic folders that stale provider cleanup must not remove yet. */
  protectedFolders: Set<string>;
  protectUnread: boolean;
};
