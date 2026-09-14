import { db } from "./pool";
import { asAccountId, asUserId } from "./types";
import type { MailAccount } from "./accounts";

function mapAccount(row: {
  id: string;
  user_id: string;
  provider: MailAccount["provider"];
  email: string;
  display_name: string | null;
  status: MailAccount["status"];
}): MailAccount {
  return {
    id: asAccountId(row.id),
    userId: asUserId(row.user_id),
    provider: row.provider,
    email: row.email,
    displayName: row.display_name,
    status: row.status,
  };
}

/** All v2 mail accounts, for background sync. Server-only. */
export async function listAllAccounts(): Promise<MailAccount[]> {
  const r = await db().query(
    `select a.id, a.user_id, a.provider, a.email, a.display_name,
            coalesce(c.status, 'reconnect_required') as status
       from seer.mail_accounts a
       left join seer.oauth_credentials c on c.account_id = a.id`,
  );
  return r.rows.map(mapAccount);
}

/** How long a disconnected mailbox waits before sync retries it. */
export const RECONNECT_RETRY_MINUTES = 30;

/**
 * The mailboxes worth starting a sync worker for.
 *
 * A mailbox whose OAuth has failed cannot sync: the worker exists only long
 * enough for the token refresh to fail again. Every five minutes, forever,
 * that is an invocation and a provider round trip bought with nothing. The
 * retry still has to happen — a refresh can fail on a transient provider
 * error, and the account must heal itself without the user reconnecting — so
 * a disconnected mailbox is retried every half hour instead of every tick.
 * `rotated_at` is the last attempt: the refresh path stamps it on failure.
 */
export async function listAccountsForSync(): Promise<MailAccount[]> {
  const r = await db().query(
    `select a.id, a.user_id, a.provider, a.email, a.display_name,
            coalesce(c.status, 'reconnect_required') as status
       from seer.mail_accounts a
       left join seer.oauth_credentials c on c.account_id = a.id
      where c.status = 'active'
         or (c.account_id is not null
             and c.rotated_at < now() - make_interval(mins => $1))
      order by lower(a.email)`,
    [RECONNECT_RETRY_MINUTES],
  );
  return r.rows.map(mapAccount);
}

/**
 * Read-cron order: the mailbox that has gone longest without a model call is
 * served first. Heap order (and "whoever connected first") starved quieter
 * desks behind a single 16k backlog.
 */
export async function listAccountsForRead(): Promise<MailAccount[]> {
  const r = await db().query(
    `select a.id, a.user_id, a.provider, a.email, a.display_name,
            coalesce(c.status, 'reconnect_required') as status
       from seer.mail_accounts a
       left join seer.oauth_credentials c on c.account_id = a.id
      order by (
        select max(u.created_at)
          from seer.model_usage u
         where u.account_id = a.id
      ) asc nulls first,
      a.email`,
  );
  return r.rows.map(mapAccount);
}
