import type { MailboxFolder, MailboxView } from "@/lib/v3/mailbox/types";

/** Never let a cached response for another folder reach the active list. */
export function viewForFolder(
  view: MailboxView | null,
  folder: MailboxFolder,
): MailboxView | null {
  return view?.folder === folder ? view : null;
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
