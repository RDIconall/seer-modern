import type { PoolClient } from "pg";
import type { AccountId } from "@/lib/v2/db/types";
import type { CorpusSnapshot, OutboxCommand, OutboxMutationKind } from "./types";

function without(folders: string[], remove: string[]): string[] {
  const drop = new Set(remove);
  return folders.filter((f) => !drop.has(f));
}

function withAdded(folders: string[], add: string[]): string[] {
  return [...new Set([...folders, ...add])];
}

function sorted(folders: string[]): string[] {
  return [...folders].sort();
}

function snapshotsEqual(a: CorpusSnapshot, b: CorpusSnapshot): boolean {
  return (
    sorted(a.folders).join("\0") === sorted(b.folders).join("\0") &&
    a.isUnread === b.isUnread
  );
}

/** Compute the corpus state after applying a mutation to `before`. */
export function computeExpected(
  type: OutboxMutationKind,
  before: CorpusSnapshot,
): CorpusSnapshot {
  if (type === "markUnread") {
    return { folders: [...before.folders], isUnread: true };
  }
  let folders: string[];
  switch (type) {
    case "archive":
      folders = withAdded(without(before.folders, ["inbox"]), ["archive"]);
      break;
    case "trash":
      folders = withAdded(without(before.folders, ["inbox", "archive"]), ["trash"]);
      break;
    case "restore":
      folders = withAdded(without(before.folders, ["trash"]), ["inbox"]);
      break;
    default: {
      const _exhaustive: never = type;
      throw new Error(`unknown mutation ${JSON.stringify(_exhaustive)}`);
    }
  }
  return { folders, isUnread: before.isUnread };
}

export type LockedConversation = {
  folders: string[];
  isUnread: boolean;
};

/** Lock a conversation row for the duration of the enclosing transaction. */
export async function lockConversation(
  client: PoolClient,
  accountId: AccountId,
  conversationId: string,
): Promise<LockedConversation | null> {
  const r = await client.query<{ folders: string[]; is_unread: boolean }>(
    `select folders, is_unread
       from seer.conversations
      where id = $1 and account_id = $2
        for update`,
    [conversationId, accountId],
  );
  const row = r.rows[0];
  if (!row) return null;
  return { folders: [...row.folders], isUnread: row.is_unread };
}

/**
 * Apply the stored expected snapshot to the corpus. Caller must hold the
 * conversation lock in the same transaction.
 */
export async function applyExpected(
  client: PoolClient,
  accountId: AccountId,
  command: OutboxCommand,
): Promise<void> {
  await client.query(
    `update seer.conversations
        set folders = $3::text[], is_unread = $4, updated_at = now()
      where id = $1 and account_id = $2`,
    [
      command.conversationId,
      accountId,
      command.expected.folders,
      command.expected.isUnread,
    ],
  );
}

/**
 * Revert only when the corpus still reflects this command's optimistic patch.
 * Returns `conflict` when a later command or sync has changed state — caller
 * must record a reconcile event instead of clobbering.
 */
export async function revertIfOwned(
  client: PoolClient,
  accountId: AccountId,
  command: OutboxCommand,
): Promise<"reverted" | "conflict"> {
  const current = await lockConversation(client, accountId, command.conversationId);
  if (!current) return "conflict";
  const now: CorpusSnapshot = {
    folders: current.folders,
    isUnread: current.isUnread,
  };
  if (!snapshotsEqual(now, command.expected)) {
    return "conflict";
  }
  await client.query(
    `update seer.conversations
        set folders = $3::text[], is_unread = $4, updated_at = now()
      where id = $1 and account_id = $2`,
    [
      command.conversationId,
      accountId,
      command.previous.folders,
      command.previous.isUnread,
    ],
  );
  return "reverted";
}
