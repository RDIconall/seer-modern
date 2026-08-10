import { db } from "./pool";
import { asAccountId, asUserId } from "./types";
import type { MailAccount } from "./accounts";

/** All v2 mail accounts, for background sync. Server-only. */
export async function listAllAccounts(): Promise<MailAccount[]> {
  const r = await db().query(
    "select id, user_id, provider, email, display_name from seer.mail_accounts",
  );
  return r.rows.map((row) => ({
    id: asAccountId(row.id),
    userId: asUserId(row.user_id),
    provider: row.provider,
    email: row.email,
    displayName: row.display_name,
  }));
}
