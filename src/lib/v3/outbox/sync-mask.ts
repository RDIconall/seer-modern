import type { PoolClient } from "pg";
import type { AccountId } from "@/lib/v2/db/types";
import { DONE_CONVERGENCE_MS, type OutboxCommand, type OutboxMutationKind, type SyncMask } from "./types";

type MaskRow = {
  command: OutboxCommand;
  status: string;
  reconcile_needed: boolean;
  updated_at: Date;
};

/** Folders additive sync must not re-introduce while an outbox command masks. */
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

function rowMaskActive(
  row: MaskRow,
  incomingLastMessageAt: string | null,
  nowMs: number,
): boolean {
  if (row.status === "pending" || row.status === "inflight") return true;
  if (row.status === "failed" && row.reconcile_needed) return true;
  if (row.status === "done") {
    const completedMs = row.updated_at.getTime();
    if (nowMs - completedMs > DONE_CONVERGENCE_MS) return false;
    if (!incomingLastMessageAt) return true;
    const incomingMs = Date.parse(incomingLastMessageAt);
    if (Number.isNaN(incomingMs)) return true;
    return incomingMs <= completedMs;
  }
  return false;
}

/**
 * Compute the sync mask for one conversation. Pending/inflight and
 * failed+reconcile_needed always mask. Done rows mask only during the bounded
 * convergence window and while provider activity is not newer than completion.
 */
export async function getSyncMask(
  client: PoolClient,
  accountId: AccountId,
  conversationId: string,
  incomingLastMessageAt: string | null,
  nowMs: number = Date.now(),
): Promise<SyncMask> {
  const r = await client.query<MaskRow>(
    `select command, status, reconcile_needed, updated_at
       from seer.outbox
      where account_id = $1
        and command->>'conversationId' = $2
        and (
          status in ('pending', 'inflight')
          or (status = 'failed' and reconcile_needed = true)
          or status = 'done'
        )`,
    [accountId, conversationId],
  );

  const blockedFolders = new Set<string>();
  let protectUnread = false;

  for (const row of r.rows) {
    if (!rowMaskActive(row, incomingLastMessageAt, nowMs)) continue;
    for (const folder of foldersBlockedByCommand(row.command.type)) {
      blockedFolders.add(folder);
    }
    if (row.command.type === "markUnread") {
      protectUnread = true;
    }
  }

  return { blockedFolders, protectUnread };
}
