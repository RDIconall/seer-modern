import { attachmentCacheState, noteCall, signedInNow } from "../attachment-cache-state.ts";

/** Stands in for auth() plus the mailbox credential lookup. */
export async function requireMailSession() {
  noteCall("requireMailSession", []);
  if (!signedInNow()) return null;
  const state = attachmentCacheState();
  return {
    accessToken: state.accessToken,
    provider: state.legacyProvider,
    email: "owner@example.com",
    name: "Owner",
    accountId: state.accountId,
  };
}
