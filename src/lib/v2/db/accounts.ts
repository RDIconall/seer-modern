import type { Pool, PoolClient } from "pg";
import { db } from "./pool";
import { inTransaction } from "./transaction";
import {
  asAccountId,
  asUserId,
  type AccountId,
  type UserId,
} from "./types";
import {
  decryptCredential,
  encryptCredential,
  type EncryptedValue,
} from "../crypto/credentials";
import { purgeMailboxStorage } from "../../store/kv";

/**
 * Account and credential repositories. Every query is scoped by both the
 * owning user and the account, so one signed-in user can never read or mutate
 * another user's mailbox rows. Secrets live encrypted in `oauth_credentials`;
 * plaintext exists only transiently inside `getCredentials`.
 */

export type MailProviderKind = "google" | "microsoft";
export type CredentialStatus = "active" | "reconnect_required";

export type MailAccount = {
  id: AccountId;
  userId: UserId;
  provider: MailProviderKind;
  email: string;
  displayName: string | null;
  status: CredentialStatus;
};

export type ProviderCredential = {
  accessToken?: string;
  refreshToken?: string;
  expiresAt?: number;
  version: number;
};

type Runner = Pool | PoolClient;

/**
 * Serialize ownership changes for one address across providers. Address-keyed
 * stores are shared by every account row with that address, so claiming and
 * releasing an address must not interleave.
 */
async function lockMailboxAddress(client: PoolClient, email: string): Promise<void> {
  await client.query("select pg_advisory_xact_lock(hashtext($1))", [
    `seer.mail_accounts:${email.toLowerCase()}`,
  ]);
}

/** OAuth providers use seconds while the application uses epoch milliseconds. */
export function normalizeEpochMs(value: number | undefined | null): number | undefined {
  if (value == null || !Number.isFinite(value) || value <= 0) return undefined;
  return value < 1e12 ? value * 1000 : value;
}

function credentialPayload(
  accountId: AccountId,
  cred: { accessToken?: string; refreshToken?: string },
  existing: Record<string, EncryptedValue> = {},
): Record<string, EncryptedValue> {
  const payload = { ...existing };
  if (cred.accessToken) {
    payload.accessToken = encryptCredential(cred.accessToken, accountId);
  }
  if (cred.refreshToken) {
    payload.refreshToken = encryptCredential(cred.refreshToken, accountId);
  }
  return payload;
}

async function saveCredentialsWithRunner(
  runner: Runner,
  accountId: AccountId,
  provider: MailProviderKind,
  cred: { accessToken?: string; refreshToken?: string; expiresAt?: number },
): Promise<void> {
  const current = await runner.query<{
    ciphertext: Record<string, EncryptedValue>;
    expires_at: Date | null;
  }>(
    `select ciphertext, expires_at
       from seer.oauth_credentials
      where account_id = $1
      for update`,
    [accountId],
  );
  const existing = current.rows[0];
  const payload = credentialPayload(accountId, cred, existing?.ciphertext);
  const expiresMs =
    normalizeEpochMs(cred.expiresAt) ??
    (existing?.expires_at ? existing.expires_at.getTime() : undefined);

  await runner.query(
    `insert into seer.oauth_credentials
       (account_id, provider, ciphertext, expires_at, version, rotated_at, status, last_error)
       values ($1, $2, $3::jsonb, to_timestamp($4), 1, now(), 'active', null)
       on conflict (account_id) do update
         set provider = excluded.provider,
             ciphertext = excluded.ciphertext,
             expires_at = excluded.expires_at,
             version = seer.oauth_credentials.version + 1,
             rotated_at = now(),
             status = 'active',
             last_error = null`,
    [accountId, provider, JSON.stringify(payload), expiresMs ? expiresMs / 1000 : null],
  );
}

export async function upsertUser(email: string): Promise<UserId> {
  const r = await db().query<{ id: string }>(
    `insert into seer.users (email) values ($1)
       on conflict (email) do update set updated_at = now()
       returning id`,
    [email.toLowerCase()],
  );
  return asUserId(r.rows[0].id);
}

export async function upsertAccount(input: {
  userId: UserId;
  provider: MailProviderKind;
  email: string;
  displayName?: string | null;
}): Promise<AccountId> {
  const r = await db().query<{ id: string }>(
    `insert into seer.mail_accounts (user_id, provider, email, display_name)
       values ($1, $2, $3, $4)
       on conflict (provider, email) do update
         set display_name = coalesce(excluded.display_name, seer.mail_accounts.display_name),
             updated_at = now()
       returning id`,
    [input.userId, input.provider, input.email.toLowerCase(), input.displayName ?? null],
  );
  return asAccountId(r.rows[0].id);
}

/**
 * Persist an OAuth callback atomically. The account row and its encrypted
 * credential row are committed together, and an address held by one user
 * (under either provider) can never be claimed by a different user.
 *
 * Creating the first row for an address purges whatever address-keyed
 * documents were left behind, so the claimer never inherits an earlier
 * owner's data. Only the legacy migration, which moves an address's own
 * records into its own account, passes `keepAddressStorage`.
 */
export async function upsertAccountWithCredentials(input: {
  userId: UserId;
  provider: MailProviderKind;
  email: string;
  displayName?: string | null;
  accessToken?: string;
  refreshToken?: string;
  expiresAt?: number;
  keepAddressStorage?: boolean;
}): Promise<MailAccount> {
  return inTransaction(async (client) => {
    const email = input.email.toLowerCase();
    await lockMailboxAddress(client, email);
    const holders = await client.query<{ user_id: string }>(
      "select user_id from seer.mail_accounts where email = $1",
      [email],
    );
    if (holders.rows.some((row) => row.user_id !== input.userId)) {
      throw new Error("mail account belongs to another user");
    }
    if (holders.rowCount === 0 && !input.keepAddressStorage) {
      await purgeMailboxStorage(email);
    }
    const accountResult = await client.query(
      `insert into seer.mail_accounts (user_id, provider, email, display_name)
         values ($1, $2, $3, $4)
         on conflict (provider, email) do update
           set display_name = coalesce(excluded.display_name, seer.mail_accounts.display_name),
               updated_at = now()
         where seer.mail_accounts.user_id = $1
         returning id, user_id, provider, email, display_name`,
      [
        input.userId,
        input.provider,
        input.email.toLowerCase(),
        input.displayName ?? null,
      ],
    );
    if (accountResult.rowCount === 0) {
      throw new Error("mail account belongs to another user");
    }
    const row = accountResult.rows[0];
    const account: MailAccount = {
      id: asAccountId(row.id),
      userId: asUserId(row.user_id),
      provider: row.provider,
      email: row.email,
      displayName: row.display_name,
      status: input.accessToken || input.refreshToken || input.expiresAt
        ? "active"
        : "reconnect_required",
    };
    if (input.accessToken || input.refreshToken || input.expiresAt) {
      await saveCredentialsWithRunner(client, account.id, input.provider, input);
    }
    return account;
  });
}

/** Fetch an account only when it belongs to the given user. */
export async function getOwnedAccount(
  userId: UserId,
  accountId: AccountId,
): Promise<MailAccount | null> {
  const r = await db().query(
    `select a.id, a.user_id, a.provider, a.email, a.display_name,
            coalesce(c.status, 'reconnect_required') as status
       from seer.mail_accounts a
       left join seer.oauth_credentials c on c.account_id = a.id
      where a.id = $1 and a.user_id = $2`,
    [accountId, userId],
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

/** List only account metadata owned by this user. Never joins credentials. */
export async function listOwnedAccounts(userId: UserId): Promise<MailAccount[]> {
  const r = await db().query(
    `select a.id, a.user_id, a.provider, a.email, a.display_name,
            coalesce(c.status, 'reconnect_required') as status
       from seer.mail_accounts a
       left join seer.oauth_credentials c on c.account_id = a.id
      where a.user_id = $1
      order by lower(a.email), a.provider`,
    [userId],
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

export async function getOwnedAccountByEmail(
  userId: UserId,
  email: string,
  provider?: MailProviderKind,
): Promise<MailAccount | null> {
  const r = await db().query(
    `select a.id, a.user_id, a.provider, a.email, a.display_name,
            coalesce(c.status, 'reconnect_required') as status
       from seer.mail_accounts a
       left join seer.oauth_credentials c on c.account_id = a.id
      where a.user_id = $1 and a.email = $2
        and ($3::text is null or a.provider = $3)
      order by a.provider
      limit 1`,
    [userId, email.toLowerCase(), provider ?? null],
  );
  const row = r.rows[0];
  return row
    ? {
        id: asAccountId(row.id),
        userId: asUserId(row.user_id),
        provider: row.provider,
        email: row.email,
        displayName: row.display_name,
       status: row.status,
      }
    : null;
}

/**
 * Delete only an account owned by the caller; credentials cascade with it.
 * When no other row keeps the address, its address-keyed documents are purged
 * before the row is released, so a later owner of the address starts empty.
 * A failed purge rolls the delete back and the address stays claimed.
 */
export async function deleteOwnedAccount(
  userId: UserId,
  accountId: AccountId,
): Promise<boolean> {
  const owned = await db().query<{ email: string }>(
    "select email from seer.mail_accounts where id = $1 and user_id = $2",
    [accountId, userId],
  );
  const email = owned.rows[0]?.email;
  if (!email) return false;

  const released = await inTransaction(async (client) => {
    await lockMailboxAddress(client, email);
    const locked = await client.query(
      `select id from seer.mail_accounts
        where id = $1 and user_id = $2 and email = $3
        for update`,
      [accountId, userId, email],
    );
    if (locked.rowCount !== 1) return null;
    const others = await client.query(
      "select 1 from seer.mail_accounts where email = $1 and id <> $2 limit 1",
      [email, accountId],
    );
    const releasesAddress = !others.rowCount;
    if (releasesAddress) await purgeMailboxStorage(email);
    await client.query(
      "delete from seer.mail_accounts where id = $1 and user_id = $2",
      [accountId, userId],
    );
    return { releasesAddress };
  });
  if (!released) return false;

  if (released.releasesAddress) {
    // Catch writes from requests that were already in flight for this mailbox.
    await purgeMailboxStorage(email).catch((e) =>
      console.error(
        "[seer] mailbox storage purge after removal failed",
        e instanceof Error ? e.message : e,
      ),
    );
  }
  return true;
}

export async function saveCredentials(
  accountId: AccountId,
  provider: MailProviderKind,
  cred: { accessToken?: string; refreshToken?: string; expiresAt?: number },
): Promise<void> {
  await inTransaction((client) =>
    saveCredentialsWithRunner(client, accountId, provider, cred),
  );
}

export async function clearCredentials(accountId: AccountId): Promise<void> {
  await db().query(
    "delete from seer.oauth_credentials where account_id = $1",
    [accountId],
  );
}

/** Record a provider refresh failure without storing provider secrets. */
export async function markCredentialsReconnectRequired(
  accountId: AccountId,
  error: string,
): Promise<void> {
  await db().query(
    `update seer.oauth_credentials
        set status = 'reconnect_required',
            last_error = $2,
            rotated_at = now()
      where account_id = $1`,
    [accountId, error.slice(0, 500)],
  );
}

export async function getCredentials(
  accountId: AccountId,
): Promise<ProviderCredential | null> {
  const r = await db().query(
    `select ciphertext, extract(epoch from expires_at) * 1000 as expires_ms, version
       from seer.oauth_credentials where account_id = $1`,
    [accountId],
  );
  const row = r.rows[0];
  if (!row) return null;
  const bag = row.ciphertext as Record<string, EncryptedValue>;
  return {
    accessToken: bag.accessToken
      ? decryptCredential(bag.accessToken, accountId)
      : undefined,
    refreshToken: bag.refreshToken
      ? decryptCredential(bag.refreshToken, accountId)
      : undefined,
    expiresAt: row.expires_ms ? Number(row.expires_ms) : undefined,
    version: row.version,
  };
}

/**
 * Rotate credentials under an optimistic version guard. Returns false when the
 * expected version no longer matches — a concurrent refresh already ran, and
 * the caller should re-read rather than clobber it.
 */
export async function rotateCredentials(
  accountId: AccountId,
  expectedVersion: number,
  next: { accessToken?: string; refreshToken?: string; expiresAt?: number },
): Promise<boolean> {
  return inTransaction(async (client: PoolClient) => {
    const cur = await client.query<{ ciphertext: Record<string, EncryptedValue> }>(
      "select ciphertext from seer.oauth_credentials where account_id = $1 and version = $2 for update",
      [accountId, expectedVersion],
    );
    if (cur.rowCount === 0) return false;
    const bag: Record<string, EncryptedValue> = { ...cur.rows[0].ciphertext };
    if (next.accessToken)
      bag.accessToken = encryptCredential(next.accessToken, accountId);
    if (next.refreshToken)
      bag.refreshToken = encryptCredential(next.refreshToken, accountId);
    await client.query(
      `update seer.oauth_credentials
          set ciphertext = $2::jsonb,
              expires_at = to_timestamp($3),
              version = version + 1,
              rotated_at = now(),
              status = 'active',
              last_error = null
        where account_id = $1`,
      [
        accountId,
        JSON.stringify(bag),
        next.expiresAt ? next.expiresAt / 1000 : null,
      ],
    );
    return true;
  });
}

/** Serialize a persisted row without ever exposing decrypted secrets. */
export async function rawCredentialRow(
  accountId: AccountId,
  runner: Runner = db(),
): Promise<string> {
  const r = await runner.query(
    "select account_id, ciphertext, version from seer.oauth_credentials where account_id = $1",
    [accountId],
  );
  return JSON.stringify(r.rows[0] ?? null);
}
