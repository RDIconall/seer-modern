/** Test double for `@/lib/mail/session`. Token value is a placeholder. */
export async function requireMailSession() {
  return {
    accessToken: "test-access-token",
    provider: "google" as const,
    email: "victim@rditrials.com",
    name: "Victim",
    accountId: "acc-1",
  };
}
