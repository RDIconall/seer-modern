import { refreshAccessToken } from "@/lib/mail/refresh-token";
import { upsertAccount, type StoredAccount } from "@/lib/store/accounts";

/**
 * THE TOKEN VAULT — background access without a browser session. The
 * product's value is what happens while the app is closed; that dies
 * if tokens only refresh inside NextAuth's session flow. Any worker
 * (cron sync, playbooks, push) calls withFreshToken and gets a live
 * access token, refreshed against the provider when stale and written
 * back to the store for everyone else.
 */

const SKEW_MS = 5 * 60_000;

export async function withFreshToken(
  account: StoredAccount,
): Promise<StoredAccount | { error: string }> {
  const expMs = (account.expiresAt ?? 0) * 1000;
  const fresh = account.accessToken && expMs && Date.now() < expMs - SKEW_MS;
  if (fresh) return account;
  if (!account.refreshToken) return { error: "no refresh token stored" };

  const refreshed = await refreshAccessToken({
    provider: account.provider,
    accessToken: account.accessToken,
    refreshToken: account.refreshToken,
    expiresAt: account.expiresAt,
  });
  if (refreshed.error || !refreshed.accessToken) {
    console.error(
      `[seer] token refresh failed for ${account.email}: ${refreshed.error}`,
    );
    return { error: refreshed.error ?? "refresh returned no token" };
  }
  return await upsertAccount({
    provider: account.provider,
    email: account.email,
    name: account.name,
    accessToken: refreshed.accessToken,
    refreshToken: refreshed.refreshToken,
    expiresAt: refreshed.expiresAt,
  });
}
