import { attachmentCacheState, noteCall, signedInNow } from "../attachment-cache-state.ts";

export async function getActiveV2Account() {
  noteCall("getActiveV2Account", []);
  if (!signedInNow()) return null;
  const state = attachmentCacheState();
  return {
    id: state.accountId,
    userId: "user-1",
    provider: "google",
    email: "owner@example.com",
    displayName: "Owner",
    status: "connected",
  };
}
