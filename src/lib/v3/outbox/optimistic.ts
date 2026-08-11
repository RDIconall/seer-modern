import type { PoolClient } from "pg";
import type { AccountId } from "@/lib/v2/db/types";
import type { OutboxCommand } from "./types";

function without(folders: string[], remove: string[]): string[] {
  const drop = new Set(remove);
  return folders.filter((f) => !drop.has(f));
}

function withAdded(folders: string[], add: string[]): string[] {
  return [...new Set([...folders, ...add])];
}

/**
 * Apply the optimistic corpus effect for one mutation command. Caller must run
 * inside the same transaction as the outbox enqueue.
 */
export async function applyOptimistic(
  client: PoolClient,
  accountId: AccountId,
  command: OutboxCommand,
): Promise<void> {
  if (command.type === "markUnread") {
    await client.query(
      `update seer.conversations
          set is_unread = true, updated_at = now()
        where id = $1 and account_id = $2`,
      [command.conversationId, accountId],
    );
    return;
  }

  let folders: string[];
  switch (command.type) {
    case "archive":
      folders = withAdded(without(command.previous.folders, ["inbox"]), ["archive"]);
      break;
    case "trash":
      folders = withAdded(without(command.previous.folders, ["inbox", "archive"]), [
        "trash",
      ]);
      break;
    case "restore":
      folders = withAdded(without(command.previous.folders, ["trash"]), ["inbox"]);
      break;
    default: {
      const _exhaustive: never = command.type;
      throw new Error(`unknown mutation ${JSON.stringify(_exhaustive)}`);
    }
  }

  await client.query(
    `update seer.conversations
        set folders = $3::text[], updated_at = now()
      where id = $1 and account_id = $2`,
    [command.conversationId, accountId, folders],
  );
}

/**
 * Revert a command to its stored pre-patch snapshot. Used for undo and for
 * permanent drain failure after max attempts.
 */
export async function revertOptimistic(
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
      command.previous.folders,
      command.previous.isUnread,
    ],
  );
}
