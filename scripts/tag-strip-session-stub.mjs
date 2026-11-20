/** Signed-in mailbox session for the tag-strip tests. Not a credential. */
export async function requireMailSession() {
  return {
    accessToken: "placeholder-access-token",
    provider: "google",
    email: "owner@example.com",
    name: "Owner",
    accountId: "acct-test",
  };
}
