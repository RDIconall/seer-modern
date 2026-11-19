/**
 * Test stand-in for NextAuth's `auth()`. The real module reads the request
 * session cookie (src/auth.ts session callback). These tests supply the
 * signed-in mailbox the attack path starts from, then run requireMailSession
 * and the route handlers unchanged.
 *
 * The address is read on each call so a test can switch mailboxes.
 */
export async function auth() {
  const email = (globalThis as { __seerTestSessionEmail?: string | null })
    .__seerTestSessionEmail;
  if (!email) return null;
  return {
    user: { email, name: "Tester" },
    provider: "google" as const,
  };
}

export const handlers = {};
export async function signIn() {}
export async function signOut() {}
