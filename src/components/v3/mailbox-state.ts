import type { Command } from "@/lib/v2/commands/types";
import type { MailboxFolder, MailboxSort, MailboxView } from "@/lib/v3/mailbox/types";

/**
 * Never let a cached response for another folder — or another sort order —
 * reach the active list. Triage-ordered rows rendered under a date-ordered
 * heading would group mail under the wrong verdict.
 */
export function viewForFolder(
  view: MailboxView | null,
  folder: MailboxFolder,
  sort: MailboxSort = "date",
): MailboxView | null {
  return view?.folder === folder && view.sort === sort ? view : null;
}

/**
 * The visible result of a batch of mutations, applied before the provider has
 * confirmed anything. Removals and unread flips are the only shapes a mailbox
 * list can show optimistically; every other command changes nothing on screen
 * until the corpus is re-read.
 */
export function applyMailboxCommands(
  view: MailboxView,
  commands: Command[],
): MailboxView {
  const removed = new Set<string>();
  const unread = new Set<string>();
  for (const command of commands) {
    if (
      command.type === "archive" ||
      command.type === "restore" ||
      command.type === "delete"
    ) {
      removed.add(command.conversationId);
    } else if (command.type === "markUnread") {
      unread.add(command.conversationId);
    }
  }
  if (removed.size === 0 && unread.size === 0) return view;

  const rows = view.rows
    .filter((row) => !removed.has(row.conversationId))
    .map((row) =>
      unread.has(row.conversationId) ? { ...row, isUnread: true } : row,
    );
  return {
    ...view,
    rows,
    total: Math.max(0, view.total - removed.size),
  };
}

/** Return the focused row and at most one adjacent row on either side. */
export function prefetchAdjacentIds(
  view: MailboxView | null,
  conversationId: string,
): string[] {
  if (!view) return [];
  const index = view.rows.findIndex((row) => row.conversationId === conversationId);
  if (index < 0) return [];
  return view.rows
    .slice(Math.max(0, index - 1), index + 2)
    .map((row) => row.conversationId);
}
