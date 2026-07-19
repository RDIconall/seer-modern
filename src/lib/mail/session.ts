import { auth } from "@/auth";
import { refreshAccessToken } from "@/lib/mail/refresh-token";
import {
  resolveActiveAccount,
  upsertAccount,
  type MailProvider,
} from "@/lib/store/accounts";

export async function requireMailSession() {
  const session = await auth();
  if (!session?.user) {
    return null;
  }

  if (session.error && !session.accessToken) {
    throw new Error("Session expired — open Settings and reconnect");
  }

  const allowed = process.env.ALLOWED_EMAIL?.trim().toLowerCase();
  const sessionEmail = session.user.email?.toLowerCase();

  let account = await resolveActiveAccount({
    provider: session.provider,
    email: session.user.email,
    name: session.user.name,
    accessToken: session.accessToken,
  });

  if (!account?.accessToken) {
    if (!session.accessToken || !session.provider) return null;
    account = {
      id: `${session.provider}:${sessionEmail}`,
      provider: session.provider as MailProvider,
      email: sessionEmail ?? "",
      name: session.user.name ?? sessionEmail ?? "",
      accessToken: session.accessToken,
      updatedAt: new Date().toISOString(),
    };
  }

  const email = account.email.toLowerCase();
  if (allowed && email && email !== allowed) {
    throw new Error(`This app is limited to ${allowed}`);
  }

  if (
    account.refreshToken &&
    account.expiresAt &&
    Date.now() >= account.expiresAt * 1000 - 60_000
  ) {
    const refreshed = await refreshAccessToken({
      accessToken: account.accessToken,
      refreshToken: account.refreshToken,
      expiresAt: account.expiresAt,
      provider: account.provider,
    });
    if (refreshed.accessToken && !refreshed.error) {
      account = await upsertAccount({
        provider: account.provider,
        email: account.email,
        name: account.name,
        accessToken: refreshed.accessToken,
        refreshToken: refreshed.refreshToken,
        expiresAt: refreshed.expiresAt,
      });
    } else if (refreshed.error) {
      throw new Error("Session expired — open Settings and reconnect");
    }
  }

  if (!account.accessToken) {
    throw new Error("No mail token — open Settings and connect an account");
  }

  return {
    accessToken: account.accessToken,
    provider: account.provider,
    email: account.email,
    name: account.name,
    accountId: account.id,
  };
}
