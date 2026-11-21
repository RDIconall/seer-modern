import { db } from "@/lib/v2/db/pool";
import type { AccountId } from "@/lib/v2/db/types";
import { nativeUrlFor } from "@/lib/v2/providers/native-url";
import type { Conversation, ProviderKind } from "@/lib/v2/providers/types";
import { CONVERSATION_PAGE_SIZE, MAX_BODY_CHARS } from "@/lib/mail/body-budget";

export type CorpusConversationView = {
  conversation: Conversation;
  nativeUrl: string;
};

/**
 * Load a corpus-backed conversation thread for the reader: its newest
 * messages, oldest-first, each body within the body budget. Returns null when
 * the conversation does not belong to the account.
 */
export async function getCorpusConversation(
  accountId: AccountId,
  conversationId: string,
  provider: ProviderKind,
): Promise<CorpusConversationView | null> {
  const c = await db().query<{
    provider_conversation_id: string;
    subject: string;
    last_message_at: string | null;
  }>(
    `select provider_conversation_id, subject, last_message_at
       from seer.conversations
      where id = $1 and account_id = $2 and is_deleted = false`,
    [conversationId, accountId],
  );
  if (c.rowCount === 0) return null;

  const msgs = await db().query<{
    provider_message_id: string;
    from_email: string | null;
    from_name: string | null;
    to_emails: string[] | null;
    cc_emails: string[] | null;
    sent_at: string | null;
    body_html: string | null;
    body_text: string | null;
    snippet: string | null;
    is_unread: boolean;
    is_outgoing: boolean;
    attachment_names: string[] | null;
  }>(
    `select provider_message_id, from_email, from_name, to_emails, cc_emails, sent_at,
            body_html, body_text, snippet, is_unread, is_outgoing, attachment_names
       from (
         select provider_message_id, from_email, from_name, to_emails, cc_emails, sent_at,
                substr(body_html, 1, $3) as body_html,
                substr(body_text, 1, $3) as body_text,
                snippet, is_unread, is_outgoing, attachment_names
           from seer.messages
          where conversation_id = $1 and account_id = $2
          order by sent_at desc nulls first, provider_message_id desc
          limit $4
       ) newest
      order by sent_at asc nulls last, provider_message_id asc`,
    [conversationId, accountId, MAX_BODY_CHARS, CONVERSATION_PAGE_SIZE],
  );

  const providerConversationId = c.rows[0].provider_conversation_id;
  const messages = msgs.rows.map((m) => ({
    providerMessageId: m.provider_message_id,
    from: { email: m.from_email ?? "", name: m.from_name ?? undefined },
    to: (m.to_emails ?? []).map((email) => ({ email })),
    cc: (m.cc_emails ?? []).map((email) => ({ email })),
    sentAt: m.sent_at ?? "",
    snippet: m.snippet ?? "",
    bodyHtml: m.body_html,
    bodyText: m.body_text,
    isUnread: m.is_unread,
    isOutgoing: m.is_outgoing,
    attachments: (m.attachment_names ?? []).map((filename, i) => ({
      id: `${m.provider_message_id}-${i}`,
      filename,
      mimeType: "",
      sizeBytes: 0,
    })),
  }));
  return {
    conversation: {
      providerConversationId,
      subject: c.rows[0].subject ?? "",
      lastMessageAt: c.rows[0].last_message_at ?? "",
      messages,
    },
    nativeUrl: nativeUrlFor(provider, providerConversationId, {
      messageId: messages[messages.length - 1]?.providerMessageId,
    }),
  };
}
