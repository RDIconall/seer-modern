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

export async function saveCredentials(
  accountId: AccountId,
  provider: MailProviderKind,
  cred: { accessToken?: string; refreshToken?: string; expiresAt?: number },
): Promise<void> {
  const payload: Record<string, EncryptedValue> = {};
  if (cred.accessToken)
    payload.accessToken = encryptCredential(cred.accessToken, accountId);
  if (cred.refreshToken)
    payload.refreshToken = encryptCredential(cred.refreshToken, accountId);
  await db().query(
    `insert into seer.oauth_credentials (account_id, provider, ciphertext, expires_at, version, rotated_at)
       values ($1, $2, $3::jsonb, to_timestamp($4), 1, now())
       on conflict (account_id) do update
         set ciphertext = $3::jsonb,
             expires_at = to_timestamp($4),
             version = seer.oauth_credentials.version + 1,
             rotated_at = now()`,
    [
      accountId,
      provider,
      JSON.stringify(payload),
      cred.expiresAt ? cred.expiresAt / 1000 : null,
    ],
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
