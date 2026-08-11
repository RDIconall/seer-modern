import { db } from "../db/pool";
import {
  getCredentials,
  markCredentialsReconnectRequired,
  rotateCredentials,
  type MailProviderKind,
  type ProviderCredential,
} from "../db/accounts";
import type { AccountId } from "../db/types";

/**
 * One place that hands out a fresh access token. Concurrent cron and user
 * requests used to each refresh independently and rotate the refresh token out
 * from under one another. Here a Postgres advisory lock scoped to the account
 * serializes refresh: whoever holds the lock re-reads the token, refreshes once
 * if still needed, rotates under an optimistic version, and everyone else waits
 * and reads the fresh value.
 */

const SKEW_MS = 5 * 60_000;

export type RefreshFn = (refreshToken: string) => Promise<{
  accessToken: string;
  refreshToken?: string;
  expiresAt: number;
}>;

function needsRefresh(cred: ProviderCredential): boolean {
  if (!cred.accessToken) return true;
  if (!cred.expiresAt) return false;
  return cred.expiresAt - Date.now() < SKEW_MS;
}

export async function freshAccessToken(
  accountId: AccountId,
  provider: MailProviderKind,
  refreshFn: RefreshFn,
): Promise<string> {
  const current = await getCredentials(accountId);
  if (!current) throw new Error(`no credentials for account ${accountId}`);
  if (!needsRefresh(current)) return current.accessToken as string;

  const client = await db().connect();
  try {
    // Let Postgres derive the 32-bit lock key from the account id so we avoid
    // JS BigInt entirely. hashtext is stable within a database.
    await client.query("select pg_advisory_lock(hashtext($1))", [accountId]);
    // Re-read under the lock: a peer may have refreshed while we waited.
    const afterLock = await getCredentials(accountId);
    if (afterLock && !needsRefresh(afterLock)) {
      return afterLock.accessToken as string;
    }
    if (!afterLock?.refreshToken) {
      const error = `no refresh token for account ${accountId}`;
      await markCredentialsReconnectRequired(accountId, error);
      throw new Error(error);
    }
    let refreshed: Awaited<ReturnType<RefreshFn>>;
    try {
      refreshed = await refreshFn(afterLock.refreshToken);
    } catch (error) {
      const message = error instanceof Error ? error.message : "provider refresh failed";
      await markCredentialsReconnectRequired(accountId, message);
      throw error;
    }
    if (!refreshed.accessToken) {
      const error = "provider refresh returned no access token";
      await markCredentialsReconnectRequired(accountId, error);
      throw new Error(error);
    }
    const ok = await rotateCredentials(accountId, afterLock.version, {
      accessToken: refreshed.accessToken,
      refreshToken: refreshed.refreshToken,
      expiresAt: refreshed.expiresAt,
    });
    if (!ok) {
      // Lost the optimistic race despite the lock (another process rotated);
      // read the winner's token.
      const latest = await getCredentials(accountId);
      if (latest?.accessToken) return latest.accessToken;
    }
    void provider;
    return refreshed.accessToken;
  } finally {
    await client
      .query("select pg_advisory_unlock(hashtext($1))", [accountId])
      .catch(() => {});
    client.release();
  }
}
