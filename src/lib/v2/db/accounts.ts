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

/**
 * Account and credential repositories. Every query is scoped by both the
 * owning user and the account, so one signed-in user can never read or mutate
 * another user's mailbox rows. Secrets live encrypted in `oauth_credentials`;
 * plaintext exists only transiently inside `getCredentials`.
 */

export type MailProviderKind = "google" | "microsoft";

export type MailAccount = {
  id: AccountId;
  userId: UserId;
  provider: MailProviderKind;
  email: string;
  displayName: string | null;
};

export type ProviderCredential = {
  accessToken?: string;
  refreshToken?: string;
  expiresAt?: number;
  version: number;
};

type Runner = Pool | PoolClient;

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
       (account_id, provider, ciphertext, expires_at, version, rotated_at)
       values ($1, $2, $3::jsonb, to_timestamp($4), 1, now())
       on conflict (account_id) do update
         set provider = excluded.provider,
             ciphertext = excluded.ciphertext,
             expires_at = excluded.expires_at,
             version = seer.oauth_credentials.version + 1,
             rotated_at = now()`,
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
 * credential row are committed together, and a provider/email conflict can
 * never be reassigned to a different user.
 */
export async function upsertAccountWithCredentials(input: {
  userId: UserId;
  provider: MailProviderKind;
  email: string;
  displayName?: string | null;
  accessToken?: string;
  refreshToken?: string;
  expiresAt?: number;
}): Promise<MailAccount> {
  return inTransaction(async (client) => {
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
    `select id, user_id, provider, email, display_name
       from seer.mail_accounts where id = $1 and user_id = $2`,
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
  };
}

/** List only account metadata owned by this user. Never joins credentials. */
export async function listOwnedAccounts(userId: UserId): Promise<MailAccount[]> {
  const r = await db().query(
    `select id, user_id, provider, email, display_name
       from seer.mail_accounts
      where user_id = $1
      order by lower(email), provider`,
    [userId],
  );
  return r.rows.map((row) => ({
    id: asAccountId(row.id),
    userId: asUserId(row.user_id),
    provider: row.provider,
    email: row.email,
    displayName: row.display_name,
  }));
}

export async function getOwnedAccountByEmail(
  userId: UserId,
  email: string,
  provider?: MailProviderKind,
): Promise<MailAccount | null> {
  const r = await db().query(
    `select id, user_id, provider, email, display_name
       from seer.mail_accounts
      where user_id = $1 and email = $2
        and ($3::text is null or provider = $3)
      order by provider
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
      }
    : null;
}

/** Delete only an account owned by the caller; credentials cascade with it. */
export async function deleteOwnedAccount(
  userId: UserId,
  accountId: AccountId,
): Promise<boolean> {
  const r = await db().query(
    "delete from seer.mail_accounts where id = $1 and user_id = $2 returning id",
    [accountId, userId],
  );
  return r.rowCount === 1;
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
              rotated_at = now()
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
