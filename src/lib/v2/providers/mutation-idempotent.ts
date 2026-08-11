import { ProviderHttpError } from "./http";
import type { MutationAction } from "./types";

/**
 * Gmail/Outlook ignore client idempotency keys, but folder mutations are
 * state-setting: repeating archive/trash/restore/markUnread when the target
 * state is already reached (or the message is gone after a prior move) is a
 * successful no-op, not an error.
 */
export function isIdempotentMutationSuccess(status: number): boolean {
  return status === 404;
}

export function mutationErrorIsNoOp(err: unknown): boolean {
  return err instanceof ProviderHttpError && isIdempotentMutationSuccess(err.status);
}

/** Gmail label sets for state-setting mutation pre-checks. */
export function gmailMutationAlreadyApplied(
  action: MutationAction,
  labelIds: string[],
): boolean {
  const labels = new Set(labelIds);
  switch (action) {
    case "archive":
      return !labels.has("INBOX");
    case "trash":
      return labels.has("TRASH");
    case "restore":
      return labels.has("INBOX") && !labels.has("TRASH");
    case "markUnread":
      return labels.has("UNREAD");
    default:
      return false;
  }
}

/** Graph well-known folder destination ids used by our move calls. */
export function outlookMutationAlreadyApplied(
  action: MutationAction,
  parentFolderId: string | undefined,
): boolean {
  const folder = (parentFolderId ?? "").toLowerCase();
  switch (action) {
    case "archive":
      return folder.includes("archive");
    case "trash":
      return folder.includes("deleted") || folder.includes("trash");
    case "restore":
      return folder.includes("inbox");
    case "markUnread":
      return false;
    default:
      return false;
  }
}
