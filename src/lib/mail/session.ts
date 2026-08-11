import { auth } from "@/auth";
import { refreshAccessToken } from "@/lib/mail/refresh-token";
import {
  getCredentials,
  getOwnedAccount,
  getOwnedAccountByEmail,
  saveCredentials,
  upsertUser,
  type MailProviderKind,
} from "@/lib/v2/db/accounts";
import { asAccountId } from "@/lib/v2/db/types";
import {
  getActiveAccountId,
  legacyAccountFallbackEnabled,
  resolveActiveAccount,
} from "@/lib/store/accounts";

export async function requireMailSession() {
  const session = await auth();
  if (!session?.user) {
    return null;
  }

  const allowed = process.env.ALLOWED_EMAIL?.trim().toLowerCase();
  const sessionEmail = session.user.email?.toLowerCase();

  if (!sessionEmail) return null;

  const userId = await upsertUser(sessionEmail);
  const provider = toV2Provider(session.provider);
  const activeId = await getActiveAccountId();
  let account = activeId
    ? await getOwnedAccount(userId, asAccountId(activeId))
    : null;
  if (!account && provider) {
    account = await getOwnedAccountByEmail(userId, sessionEmail, provider);
  }

  if (account) {
    const credentials = await getCredentials(account.id);
    if (!credentials) {
      throw new Error("No mail credentials — open Settings and reconnect");
    }

    let accessToken = credentials.accessToken;
    const expiresAtSeconds = credentials.expiresAt
      ? Math.floor(credentials.expiresAt / 1000)
      : undefined;
    if (
      credentials.refreshToken &&
      (!accessToken ||
        (credentials.expiresAt !== undefined &&
          Date.now() >= credentials.expiresAt - 60_000))
    ) {
      const refreshed = await refreshAccessToken({
        accessToken,
        refreshToken: credentials.refreshToken,
        expiresAt: expiresAtSeconds,
        provider: account.provider === "google" ? "google" : "microsoft-entra-id",
      });
      if (!refreshed.accessToken || refreshed.error) {
        throw new Error("Session expired — open Settings and reconnect");
      }
      accessToken = refreshed.accessToken;
      await saveCredentials(account.id, account.provider, {
        accessToken: refreshed.accessToken,
        refreshToken: refreshed.refreshToken,
        expiresAt: refreshed.expiresAt,
      });
    }

    if (!accessToken) {
      throw new Error("No mail token — open Settings and connect an account");
    }

    const email = account.email.toLowerCase();
    if (allowed && email && email !== allowed) {
      throw new Error(`This app is limited to ${allowed}`);
    }
    return {
      accessToken,
      provider: account.provider === "google" ? "google" : "microsoft-entra-id",
      email: account.email,
      name: account.displayName ?? account.email,
      accountId: account.id,
    };
  }

  // During migration only, old sessions and the sealed KV store remain a
  // read-only compatibility path. SEER_V3_LEGACY_ACCOUNT_FALLBACK is the
  // explicit temporary flag; the canonical path never dual-writes.
  if (!legacyAccountFallbackEnabled()) return null;
  const legacyProvider =
    session.provider === "google"
      ? "google"
      : session.provider === "microsoft-entra-id"
        ? "microsoft-entra-id"
        : undefined;
  const legacy = await resolveActiveAccount(
    sessionEmail,
    legacyProvider,
  );
  if (!legacy?.accessToken) return null;

  const email = legacy.email.toLowerCase();
  if (allowed && email && email !== allowed) {
    throw new Error(`This app is limited to ${allowed}`);
  }

  if (
    legacy.refreshToken &&
    legacy.expiresAt &&
    Date.now() >= legacy.expiresAt * 1000 - 60_000
  ) {
    const refreshed = await refreshAccessToken(legacy);
    if (!refreshed.accessToken || refreshed.error) {
      throw new Error("Session expired — open Settings and reconnect");
    }
    legacy.accessToken = refreshed.accessToken;
  }

  return {
    accessToken: legacy.accessToken,
    provider: legacy.provider,
    email: legacy.email,
    name: legacy.name,
    accountId: legacy.id,
  };
}

function toV2Provider(provider: string | undefined): MailProviderKind | undefined {
  if (provider === "google") return "google";
  if (provider === "microsoft-entra-id" || provider === "microsoft") {
    return "microsoft";
  }
  return undefined;
}
