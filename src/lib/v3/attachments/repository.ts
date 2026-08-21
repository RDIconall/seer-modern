import { db } from "@/lib/v2/db/pool";
import type { AccountId } from "@/lib/v2/db/types";
import type { Conversation } from "@/lib/v2/providers/types";

export type OwnedMessage = {
  providerMessageId: string;
  providerConversationId: string;
  attachmentNames: string[];
};

/**
 * Verify a provider message id belongs to the account. Used before streaming
 * attachment bytes through the provider adapter.
 */
export async function verifyMessageOwnership(
  accountId: AccountId,
  providerMessageId: string,
): Promise<OwnedMessage | null> {
  const r = await db().query<{
    provider_message_id: string;
    provider_conversation_id: string;
    attachment_names: string[] | null;
  }>(
    `select m.provider_message_id,
            c.provider_conversation_id,
            m.attachment_names
       from seer.messages m
       join seer.conversations c on c.id = m.conversation_id
      where m.account_id = $1
        and m.provider_message_id = $2
        and c.is_deleted = false`,
    [accountId, providerMessageId],
  );
  const row = r.rows[0];
  if (!row) return null;
  return {
    providerMessageId: row.provider_message_id,
    providerConversationId: row.provider_conversation_id,
    attachmentNames: row.attachment_names ?? [],
  };
}

/** Resolve corpus synthetic attachment ids (`providerMessageId-index`). */
export function resolveAttachmentMeta(
  message: OwnedMessage,
  attachmentId: string,
): { filename: string; index: number } {
  const prefix = `${message.providerMessageId}-`;
  if (attachmentId.startsWith(prefix)) {
    const index = Number(attachmentId.slice(prefix.length));
    const filename = message.attachmentNames[index] ?? "attachment";
    return { filename, index };
  }
  const index = message.attachmentNames.findIndex((name) => name === attachmentId);
  return {
    filename: index >= 0 ? message.attachmentNames[index]! : attachmentId,
    index: index >= 0 ? index : 0,
  };
}

/** Map a corpus filename/index back to the provider's opaque attachment id. */
export function findProviderAttachmentId(
  conversation: Conversation,
  providerMessageId: string,
  meta: { filename: string; index: number },
): string | null {
  const message = conversation.messages.find(
    (item) => item.providerMessageId === providerMessageId,
  );
  const attachment =
    message?.attachments[meta.index] ??
    message?.attachments.find((item) => item.filename === meta.filename);
  return attachment?.id || null;
}
