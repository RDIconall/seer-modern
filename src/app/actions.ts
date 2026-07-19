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

export async function logout() {
  await signOut({ redirectTo: "/" });
}

export async function logoutMobile() {
  await signOut({ redirectTo: "/m" });
}
