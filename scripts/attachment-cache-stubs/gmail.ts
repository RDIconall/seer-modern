import { attachmentCacheState, noteCall } from "../attachment-cache-state.ts";

export async function getGmailAttachment(
  accessToken: string,
  messageId: string,
  attachmentId: string,
): Promise<Buffer> {
  noteCall("getGmailAttachment", [messageId, attachmentId]);
  const state = attachmentCacheState();
  if (
    accessToken !== state.accessToken ||
    messageId !== state.messageId ||
    attachmentId !== state.providerAttachmentId
  ) {
    throw new Error("not the authorized attachment");
  }
  return Buffer.from(state.bytes);
}
