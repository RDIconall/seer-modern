import type { MailboxFolder, MailboxSort, MailboxView } from "./types";

/**
 * Browser cache for a folder view. Five minutes is long enough that rotating
 * back to Inbox does not flash empty, and short enough that signing in after
 * lunch cannot paint yesterday's mail.
 */
export const MAILBOX_CACHE_MAX_AGE_MS = 5 * 60 * 1000;

export type MailboxCacheEnvelope = {
  savedAt: number;
  view: MailboxView;
};

export function wrapMailboxCache(
  view: MailboxView,
  savedAt = Date.now(),
): MailboxCacheEnvelope {
  return { savedAt, view };
}

export function isMailboxCacheFresh(
  cached: MailboxCacheEnvelope | MailboxView | null | undefined,
  now = Date.now(),
): boolean {
  if (!cached || typeof cached !== "object") return false;
  if (!("savedAt" in cached) || typeof (cached as MailboxCacheEnvelope).savedAt !== "number") {
    return false;
  }
  if (!("view" in cached) || !(cached as MailboxCacheEnvelope).view) return false;
  return now - (cached as MailboxCacheEnvelope).savedAt <= MAILBOX_CACHE_MAX_AGE_MS;
}

export function unwrapMailboxCache(
  cached: unknown,
  accountId: string,
  folder: MailboxFolder,
  sort: MailboxSort,
  now = Date.now(),
): MailboxView | null {
  if (!isMailboxCacheFresh(cached as MailboxCacheEnvelope, now)) return null;
  const view = (cached as MailboxCacheEnvelope).view;
  if (
    view.accountId !== accountId ||
    view.folder !== folder ||
    view.sort !== sort ||
    !Array.isArray(view.rows)
  ) {
    return null;
  }
  return view;
}
