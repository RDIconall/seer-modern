import {
  findProviderAttachmentId,
  resolveAttachmentMeta,
} from "../../src/lib/v3/attachments/repository.ts";
import { attachmentCacheState, noteCall } from "../attachment-cache-state.ts";

export { findProviderAttachmentId, resolveAttachmentMeta };

export async function verifyMessageOwnership(accountId: string, providerMessageId: string) {
  noteCall("verifyMessageOwnership", [accountId, providerMessageId]);
  const state = attachmentCacheState();
  if (accountId !== state.accountId || providerMessageId !== state.messageId) return null;
  return {
    providerMessageId,
    providerConversationId: state.conversationId,
    attachmentNames: [state.filename],
  };
}
