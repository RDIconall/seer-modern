import type { AccountId } from "@/lib/v2/db/types";
import {
  boundThreadMessages,
  THREAD_READ_BODY_BYTE_CAP,
  THREAD_READ_MESSAGE_CAP,
  THREAD_READ_STATEMENT_TIMEOUT_MS,
} from "@/lib/v2/db/thread-read-bounds";
import { inBoundedRead } from "@/lib/v2/db/transaction";
import { nativeUrlFor } from "@/lib/v2/providers/native-url";
import type { Conversation, Message, ProviderKind } from "@/lib/v2/providers/types";

export type CorpusConversationView = {
  conversation: Conversation;
  nativeUrl: string;
};

/**
 * Load one page of a corpus-backed conversation thread for the reader: the
 * newest messages after skipping `olderThan` of them, within the thread read
 * caps. Returns null when the conversation does not belong to the account.
 */
export async function getCorpusConversation(
  accountId: AccountId,
  conversationId: string,
  provider: ProviderKind,
  options: { olderThan?: number } = {},
): Promise<CorpusConversationView | null> {
  const skip = Math.max(0, Math.floor(options.olderThan ?? 0));
  const loaded = await inBoundedRead(THREAD_READ_STATEMENT_TIMEOUT_MS, async (client) => {
    const c = await client.query<{
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

    // substr keeps detoasting to the prefix a response could ever use. One
    // character is at least one byte, so a body cut here is always over the
    // byte cap and is marked truncated below.
    const msgs = await client.query<{
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
      total: number;
    }>(
      `with page as (
         select id, count(*) over ()::int as total
           from seer.messages
          where conversation_id = $1 and account_id = $2
          order by sent_at desc nulls first, provider_message_id desc
          offset $3 limit $4
       )
       select provider_message_id, from_email, from_name, to_emails, cc_emails, sent_at,
              body_html, body_text, snippet, is_unread, is_outgoing, attachment_names, total
         from (
           select m.provider_message_id, m.from_email, m.from_name, m.to_emails, m.cc_emails,
                  m.sent_at, substr(m.body_html, 1, $5) as body_html,
                  substr(m.body_text, 1, $5) as body_text, m.snippet, m.is_unread,
                  m.is_outgoing, m.attachment_names, page.total
             from page
             join seer.messages m on m.id = page.id
         ) bounded
        order by sent_at desc nulls first, provider_message_id desc`,
      [conversationId, accountId, skip, THREAD_READ_MESSAGE_CAP, THREAD_READ_BODY_BYTE_CAP + 1],
    );
    return { conversation: c.rows[0], messages: msgs.rows };
  });
  if (!loaded) return null;

  const newestFirst: Message[] = loaded.messages.map((m) => ({
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
  const messages = boundThreadMessages(newestFirst);
  const total = loaded.messages[0]?.total ?? skip;
  const omittedMessageCount = Math.max(0, total - skip - messages.length);

  const providerConversationId = loaded.conversation.provider_conversation_id;
  return {
    conversation: {
      providerConversationId,
      subject: loaded.conversation.subject ?? "",
      lastMessageAt: loaded.conversation.last_message_at ?? "",
      messages,
      omittedMessageCount,
    },
    nativeUrl: nativeUrlFor(provider, providerConversationId, {
      messageId: messages[messages.length - 1]?.providerMessageId,
    }),
  };
}
