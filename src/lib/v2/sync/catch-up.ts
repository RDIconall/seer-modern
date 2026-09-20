import { db } from "@/lib/v2/db/pool";
import type { MailAccount } from "@/lib/v2/db/accounts";
import type { AccountId } from "@/lib/v2/db/types";
import { providerFor } from "@/lib/v2/providers/provider";
import { loadFolderSyncState } from "@/lib/v2/sync/repository";
import { syncFolder } from "@/lib/v2/sync/engine";

/**
 * Longer than a healthy five-minute cron tick, short enough that signing in
 * after a stuck sync still pulls what arrived while the user was away.
 */
export const INBOX_CATCH_UP_STALE_MS = 15 * 60 * 1000;
/** Login must not wait out a historical backfill. One head page is the catch-up. */
export const INBOX_CATCH_UP_DEADLINE_MS = 25_000;
/**
 * Gmail charges ~40 units per full thread. A 100-thread page blows the
 * per-user minute and cannot finish inside the login deadline, so catch-up
 * reads a short newest-first page instead.
 */
export const GMAIL_CATCH_UP_PAGE_SIZE = 15;

export function inboxCatchUpDue(
  lastSyncedAt: Date | string | null | undefined,
  now = Date.now(),
): boolean {
  if (lastSyncedAt == null) return true;
  const ts =
    lastSyncedAt instanceof Date ? lastSyncedAt.getTime() : Date.parse(String(lastSyncedAt));
  if (!Number.isFinite(ts)) return true;
  return now - ts >= INBOX_CATCH_UP_STALE_MS;
}

export async function latestInboxSyncAt(
  accountId: AccountId,
): Promise<Date | null> {
  const result = await db().query<{ t: Date | string | null }>(
    `select max(last_synced_at) as t
       from seer.conversations
      where account_id = $1
        and folders @> array['inbox']::text[]`,
    [accountId],
  );
  const value = result.rows[0]?.t ?? null;
  if (!value) return null;
  return value instanceof Date ? value : new Date(value);
}

export async function inboxNeedsCatchUp(
  accountId: AccountId,
  now = Date.now(),
): Promise<boolean> {
  const state = await loadFolderSyncState(accountId, "inbox");
  if (!state.backfillComplete) return true;
  return inboxCatchUpDue(await latestInboxSyncAt(accountId), now);
}

const recentlyKicked = new Map<string, number>();

/**
 * Schedule a newest-first provider head-poll when the corpus is stale or the
 * historical scan is still running. A Gmail backfill that never finished must
 * not hide new mail behind the next old page.
 */
export async function kickInboxCatchUp(
  account: MailAccount,
  schedule: (work: () => Promise<void>) => void,
  now = Date.now(),
): Promise<boolean> {
  if (account.status !== "active") return false;
  const lastKick = recentlyKicked.get(account.id);
  if (lastKick != null && now - lastKick < 60_000) return true;
  if (!(await inboxNeedsCatchUp(account.id, now))) return false;
  recentlyKicked.set(account.id, now);
  schedule(() => catchUpInbox(account));
  return true;
}

export async function catchUpInbox(account: MailAccount): Promise<void> {
  if (account.status !== "active") return;
  if (!(await inboxNeedsCatchUp(account.id))) return;

  try {
    const provider = await providerFor(account);
    await syncFolder(account.id, provider, "inbox", "incremental", {
      maxPages: 1,
      headOnly: true,
      deadlineMs: Date.now() + INBOX_CATCH_UP_DEADLINE_MS,
      pageSize:
        account.provider === "google" ? GMAIL_CATCH_UP_PAGE_SIZE : undefined,
    });
  } finally {
    recentlyKicked.delete(account.id);
  }
}
