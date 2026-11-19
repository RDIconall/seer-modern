import { DRAFT_STORAGE_KEY_PREFIX } from "../compose/draft";
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

/** Login cannot import the mailbox hook just to drop last week's rows. */
export const MAILBOX_CACHE_KEY_PREFIX = "seer.v3.mailbox.";

/** Folder snapshots written by the legacy inbox hook. */
export const LEGACY_VIEW_CACHE_KEY_PREFIX = "seer:v3:";

/**
 * Everything a mailbox session leaves in localStorage: folder caches and
 * unsent drafts (recipients, subject, body). Sign-out, sign-in, and account
 * switches must drop all of it, or the next person at the browser reads it.
 */
const SESSION_STORAGE_KEY_PREFIXES = [
  MAILBOX_CACHE_KEY_PREFIX,
  LEGACY_VIEW_CACHE_KEY_PREFIX,
  DRAFT_STORAGE_KEY_PREFIX,
];

export function clearPersistedMailboxCaches(): void {
  if (typeof window === "undefined") return;
  try {
    for (let i = window.localStorage.length - 1; i >= 0; i--) {
      const key = window.localStorage.key(i);
      if (key && SESSION_STORAGE_KEY_PREFIXES.some((prefix) => key.startsWith(prefix))) {
        window.localStorage.removeItem(key);
      }
    }
  } catch {
    // Cache cleanup must never block sign-in.
  }
}
