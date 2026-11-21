/**
 * Test stand-in for the signed-in mailbox owner. The route under test calls
 * requireMailSession before it reads Outlook; this returns that session
 * without a credential value.
 */
export async function requireMailSession() {
  return {
    accessToken: "access-token-placeholder",
    provider: "microsoft-entra-id" as const,
    email: "owner@rditrials.com",
    name: "Owner",
    accountId: "00000000-0000-4000-8000-000000000001",
  };
}
