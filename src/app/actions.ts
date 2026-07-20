"use server";

import { signIn, signOut } from "@/auth";
import { revokeProviderGrant } from "@/lib/mail/revoke";
import { clearAccountTokens, getAccount } from "@/lib/store/accounts";

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
  await signIn("google", { redirectTo: "/?settings=1" });
}

export async function connectMicrosoftDesktop() {
  await signIn("microsoft-entra-id", { redirectTo: "/?settings=1" });
}

/** Connect / add account from Settings (mobile). */
export async function connectGoogleMobile() {
  await signIn("google", { redirectTo: "/m?settings=1" });
}

export async function connectMicrosoftMobile() {
  await signIn("microsoft-entra-id", { redirectTo: "/m?settings=1" });
}

/**
 * One-tap reconnect: revoke the old grant at the provider, drop the dead
 * tokens, and immediately restart sign-in with a fresh consent screen
 * pre-filled to the same address. Used to fix missed permissions without
 * ever leaving the app.
 */
export async function reconnectAccount(id: string, mobile?: boolean) {
  const account = await getAccount(id);
  const redirectTo = mobile ? "/m?settings=1" : "/?settings=1";
  if (!account) {
    await signIn("google", { redirectTo });
    return;
  }
  await revokeProviderGrant(account);
  await clearAccountTokens(id);
  await signIn(
    account.provider,
    { redirectTo },
    { login_hint: account.email, prompt: "consent" },
  );
}

export async function logout() {
  await signOut({ redirectTo: "/" });
}

export async function logoutMobile() {
  await signOut({ redirectTo: "/m" });
}
