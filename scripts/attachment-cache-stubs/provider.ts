import { attachmentCacheState, noteCall } from "../attachment-cache-state.ts";

export async function providerFor() {
  const state = attachmentCacheState();
  return {
    async getConversation(conversationId: string) {
      noteCall("getConversation", [conversationId]);
      if (conversationId !== state.conversationId) {
        throw new Error("wrong conversation");
      }
      return {
        providerConversationId: state.conversationId,
        subject: "Invoice",
        lastMessageAt: "2026-08-11T15:20:00.000Z",
        messages: [
          {
            providerMessageId: state.messageId,
            from: { email: "sender@example.com" },
            to: [{ email: "owner@example.com" }],
            cc: [],
            sentAt: "2026-08-11T15:20:00.000Z",
            snippet: "",
            bodyHtml: null,
            bodyText: "",
            isUnread: false,
            isOutgoing: false,
            attachments: [
              {
                id: state.providerAttachmentId,
                filename: state.filename,
                mimeType: state.mimeType,
                sizeBytes: state.bytes.length,
              },
            ],
          },
        ],
      };
    },
    async getAttachment(messageId: string, attachmentId: string) {
      noteCall("getAttachment", [messageId, attachmentId]);
      if (messageId !== state.messageId || attachmentId !== state.providerAttachmentId) {
        throw new Error("not the authorized attachment");
      }
      return {
        body: Buffer.from(state.bytes),
        mimeType: state.mimeType,
        filename: state.filename,
      };
    },
  };
}
