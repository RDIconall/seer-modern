import { auth } from "@/auth";

export async function requireMailSession() {
  const session = await auth();
  if (!session?.accessToken || !session.provider) {
    return null;
  }
  if (session.error) {
    throw new Error("Session expired — sign out and connect again");
  }
  const allowed = process.env.ALLOWED_EMAIL?.trim().toLowerCase();
  const email = session.user?.email?.toLowerCase();
  if (allowed && email && email !== allowed) {
    throw new Error(`This app is limited to ${allowed}`);
  }
  return {
    accessToken: session.accessToken,
    provider: session.provider as "google" | "microsoft-entra-id",
    email: session.user?.email ?? "",
  };
}
