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
