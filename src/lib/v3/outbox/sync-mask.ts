import type { PoolClient } from "pg";
import type { AccountId } from "@/lib/v2/db/types";
import type { OutboxCommand, OutboxMutationKind } from "./types";

const MASK_STATUSES = ["pending", "inflight", "done"] as const;

/** Folders additive sync must not re-introduce while outbox commands are active. */
function foldersBlockedByCommand(type: OutboxMutationKind): string[] {
  switch (type) {
    case "archive":
      return ["inbox"];
    case "trash":
      return ["inbox", "archive"];
    case "restore":
      return ["trash"];
    case "markUnread":
      return [];
    default: {
      const _exhaustive: never = type;
      return [];
    }
  }
}

/**
 * Folders that must not be merged back in by additive sync for a conversation
 * with active outbox commands (pending, inflight, or done awaiting provider
 * convergence).
 */
export async function blockedSyncFolders(
  client: PoolClient,
  accountId: AccountId,
  conversationId: string,
): Promise<Set<string>> {
  const r = await client.query<{ command: OutboxCommand }>(
    `select command
       from seer.outbox
      where account_id = $1
        and status = any($2::text[])
        and command->>'conversationId' = $3`,
    [accountId, MASK_STATUSES, conversationId],
  );
  const blocked = new Set<string>();
  for (const row of r.rows) {
    for (const folder of foldersBlockedByCommand(row.command.type)) {
      blocked.add(folder);
    }
  }
  return blocked;
}
