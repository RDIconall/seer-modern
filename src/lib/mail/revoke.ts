import type { StoredAccount } from "@/lib/store/accounts";

/**
 * Revoke an account's OAuth grant at the provider so the next sign-in
 * shows a completely fresh consent screen.
 *
 * Google: revoking the refresh token kills the whole grant (all scopes).
 * Microsoft: there is no self-serve per-app revocation endpoint; we rely
 * on prompt=consent at the next sign-in, which re-asks for permissions.
 */
export async function revokeProviderGrant(account: StoredAccount) {
  if (account.provider !== "google") return;

  const token = account.refreshToken ?? account.accessToken;
  if (!token) return;

  try {
    await fetch("https://oauth2.googleapis.com/revoke", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token }),
    });
  } catch {
    // Best effort — a dead token is revoked already; consent still resets
    // because reconnect signs in with prompt=consent.
  }
}
