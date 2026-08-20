import { db } from "@/lib/v2/db/pool";
import { asAccountId, asUserId, type AccountId } from "@/lib/v2/db/types";
import type { MailAccount } from "@/lib/v2/db/accounts";
import { providerFor } from "@/lib/v2/providers/provider";
import { syncFolder } from "@/lib/v2/sync/engine";
import { readBatch } from "@/lib/v2/intelligence/read-batch";
import { defaultReaderModel } from "@/lib/v2/intelligence/model";
import { fileMatters } from "@/lib/v2/intelligence/file-matters";
import { seedFunctions } from "@/lib/v2/intelligence/functions";
import { drainOutbox } from "@/lib/v3/outbox/drain";

/**
 * Wake one account after a push notification: head-poll inbox, then read
 * whatever landed. Bounded so a webhook never starts a full historical scan.
 */

export type WakeReport = {
  accountId: string;
  email: string;
  outbox?: unknown;
  sync?: unknown;
  read?: unknown;
  filing?: unknown;
  error?: string;
};

export async function getAccountById(
  accountId: AccountId,
): Promise<MailAccount | null> {
  const r = await db().query(
    `select a.id, a.user_id, a.provider, a.email, a.display_name,
            coalesce(c.status, 'reconnect_required') as status
       from seer.mail_accounts a
       left join seer.oauth_credentials c on c.account_id = a.id
      where a.id = $1`,
    [accountId],
  );
  const row = r.rows[0];
  if (!row) return null;
  return {
    id: asAccountId(row.id),
    userId: asUserId(row.user_id),
    provider: row.provider,
    email: row.email,
    displayName: row.display_name,
    status: row.status,
  };
}

export async function getAccountByEmail(
  email: string,
): Promise<MailAccount | null> {
  const r = await db().query(
    `select a.id, a.user_id, a.provider, a.email, a.display_name,
            coalesce(c.status, 'reconnect_required') as status
       from seer.mail_accounts a
       left join seer.oauth_credentials c on c.account_id = a.id
      where a.email = $1
      order by case a.provider when 'microsoft' then 0 when 'google' then 1 else 2 end
      limit 1`,
    [email.toLowerCase()],
  );
  const row = r.rows[0];
  if (!row) return null;
  return {
    id: asAccountId(row.id),
    userId: asUserId(row.user_id),
    provider: row.provider,
    email: row.email,
    displayName: row.display_name,
    status: row.status,
  };
}

export async function wakeAccount(accountId: AccountId): Promise<WakeReport> {
  const account = await getAccountById(accountId);
  if (!account) {
    return { accountId, email: "", error: "account not found" };
  }
  if (account.status !== "active") {
    return {
      accountId,
      email: account.email,
      error: `account status ${account.status}`,
    };
  }

  try {
    const provider = await providerFor(account);
    const outbox = await drainOutbox(account.id, provider);
    const deadlineMs = Date.now() + 240_000;
    const sync = await syncFolder(account.id, provider, "inbox", "incremental", {
      maxPages: 1,
      deadlineMs,
    });
    const read = await readBatch(
      account.id,
      account.email,
      defaultReaderModel,
      { limit: 50, concurrency: 4, deadlineMs },
    );
    await seedFunctions(account.id);
    let filing: unknown;
    try {
      filing = await fileMatters(account.id, { limit: 50 });
    } catch (e) {
      filing = {
        error: e instanceof Error ? e.message.slice(0, 120) : "filing failed",
      };
    }
    return {
      accountId,
      email: account.email,
      outbox,
      sync: {
        pages: sync.pages,
        complete: sync.complete,
        polledHead: sync.polledHead,
      },
      read,
      filing,
    };
  } catch (e) {
    return {
      accountId,
      email: account.email,
      error: e instanceof Error ? e.message.slice(0, 200) : "wake failed",
    };
  }
}
