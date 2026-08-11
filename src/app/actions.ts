"use server";

import { auth } from "@/auth";
import { signIn, signOut } from "@/auth";
import { revokeProviderGrant } from "@/lib/mail/revoke";
import {
  beginAccountLinkState,
  type AccountLinkProvider,
} from "@/lib/auth/account-link";
import {
  clearCredentials,
  getCredentials,
  getOwnedAccount,
  upsertUser,
} from "@/lib/v2/db/accounts";
import { asAccountId } from "@/lib/v2/db/types";
import { setActiveAccountId } from "@/lib/store/accounts";

export async function loginGoogle() {
  await signIn("google", { redirectTo: "/" });
}

export async function loginMicrosoft() {
  await signIn("microsoft-entra-id", { redirectTo: "/" });
}

export async function loginGoogleMobile() {
  await signIn("google", { redirectTo: "/m" });
}

export async function loginMicrosoftMobile() {
  await signIn("microsoft-entra-id", { redirectTo: "/m" });
}

/** Connect / add account from Settings (desktop). */
export async function connectGoogleDesktop() {
  await connectAccount("google", "/?settings=1");
}

export async function connectMicrosoftDesktop() {
  await connectAccount("microsoft-entra-id", "/?settings=1");
}

/** Connect / add account from Settings (mobile). */
export async function connectGoogleMobile() {
  await connectAccount("google", "/m?settings=1");
}

export async function connectMicrosoftMobile() {
  await connectAccount("microsoft-entra-id", "/m?settings=1");
}

async function connectAccount(
  provider: AccountLinkProvider,
  redirectTo: string,
  accountId?: string,
) {
  const session = await auth();
  const email = session?.user?.email?.trim().toLowerCase();
  if (!email) throw new Error("Sign in before adding another account");
  const userId = await upsertUser(email);
  await beginAccountLinkState({
    ownerUserId: userId,
    ownerEmail: email,
    provider,
    accountId,
  });
  await signIn(
    provider,
    { redirectTo },
    { prompt: "consent" },
  );
}

/**
 * One-tap reconnect: revoke the old grant at the provider, drop the dead
 * tokens, and immediately restart sign-in with a fresh consent screen
 * pre-filled to the same address. Used to fix missed permissions without
 * ever leaving the app.
 */
export async function reconnectAccount(id: string, mobile?: boolean) {
  const session = await auth();
  const email = session?.user?.email?.trim().toLowerCase();
  if (!email) throw new Error("Not signed in");
  const userId = await upsertUser(email);
  const account = await getOwnedAccount(userId, asAccountId(id));
  const redirectTo = mobile ? "/m?settings=1" : "/?settings=1";
  if (!account) {
    throw new Error("Account not found");
  }
  const credentials = await getCredentials(account.id);
  if (credentials) {
    await revokeProviderGrant({
      id: account.id,
      provider: account.provider === "google" ? "google" : "microsoft-entra-id",
      email: account.email,
      name: account.displayName ?? account.email,
      accessToken: credentials.accessToken,
      refreshToken: credentials.refreshToken,
      expiresAt: credentials.expiresAt
        ? Math.floor(credentials.expiresAt / 1000)
        : undefined,
      updatedAt: new Date().toISOString(),
    });
  }
  await clearCredentials(account.id);
  await setActiveAccountId(account.id);
  await connectAccount(
    account.provider === "google" ? "google" : "microsoft-entra-id",
    redirectTo,
    account.id,
  );
}

export async function logout() {
  await signOut({ redirectTo: "/" });
}

export async function logoutMobile() {
  await signOut({ redirectTo: "/m" });
}
