"use server";

import { signIn, signOut } from "@/auth";

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

export async function logout() {
  await signOut({ redirectTo: "/" });
}

export async function logoutMobile() {
  await signOut({ redirectTo: "/m" });
}
