import { db } from "./pool";
import { asAccountId, asUserId } from "./types";
import type { MailAccount } from "./accounts";

/** All v2 mail accounts, for background sync. Server-only. */
export async function listAllAccounts(): Promise<MailAccount[]> {
  const r = await db().query(
    `select a.id, a.user_id, a.provider, a.email, a.display_name,
            coalesce(c.status, 'reconnect_required') as status
       from seer.mail_accounts a
       left join seer.oauth_credentials c on c.account_id = a.id`,
  );
  return r.rows.map((row) => ({
    id: asAccountId(row.id),
    userId: asUserId(row.user_id),
    provider: row.provider,
    email: row.email,
    displayName: row.display_name,
    status: row.status,
  }));
}
