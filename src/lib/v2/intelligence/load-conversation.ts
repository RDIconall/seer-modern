import {
  boundThreadMessages,
  THREAD_READ_MESSAGE_CAP,
  THREAD_READ_STATEMENT_TIMEOUT_MS,
} from "../db/thread-read-bounds";
import { inBoundedRead } from "../db/transaction";
import type { AccountId } from "../db/types";
import type { Conversation, Message } from "../providers/types";
import { storedBodyText } from "./html-text";

/**
 * Columns the chief-of-staff read needs. `body_html` is only detoasted when
 * `body_text` is empty: Postgres does not evaluate the unused CASE branch, so
 * the ~37KB HTML bodies that dominate database egress stay toasted.
 */
export const MESSAGES_FOR_READ_SQL = `m.provider_message_id, m.from_email, m.from_name, m.to_emails, m.cc_emails, m.sent_at,
       case when nullif(btrim(coalesce(m.body_text, '')), '') is not null
            then null
            else m.body_html
       end as body_html,
       m.body_text, m.snippet, m.is_unread, m.is_outgoing, m.attachment_names`;

export type MessageReadRow = {
  provider_message_id: string | null;
  from_email: string | null;
  from_name: string | null;
  to_emails: string[] | null;
  cc_emails: string[] | null;
  sent_at: string | Date | null;
  body_html: string | null;
  body_text: string | null;
  snippet: string | null;
  is_unread: boolean | null;
  is_outgoing: boolean | null;
  attachment_names: string[] | null;
};

function iso(value: string | Date | null | undefined): string {
  if (!value) return "";
  return value instanceof Date ? value.toISOString() : String(value);
}

export function messageFromReadRow(row: MessageReadRow): Message | null {
  if (!row.provider_message_id) return null;
  const bodyText = storedBodyText({
    bodyText: row.body_text,
    bodyHtml: row.body_html,
  });
  return {
    providerMessageId: row.provider_message_id,
    from: { email: row.from_email ?? "", name: row.from_name ?? undefined },
    to: (row.to_emails ?? []).map((email) => ({ email })),
    cc: (row.cc_emails ?? []).map((email) => ({ email })),
    sentAt: iso(row.sent_at),
    snippet: row.snippet ?? "",
    // Drop HTML from the in-memory read once text exists — the model never
    // wants markup, and holding it would re-inflate the payload we just saved.
    bodyHtml: bodyText ? null : row.body_html,
    bodyText,
    isUnread: Boolean(row.is_unread),
    isOutgoing: Boolean(row.is_outgoing),
    attachments: (row.attachment_names ?? []).map((filename, i) => ({
      id: `${row.provider_message_id}-${i}`,
      filename,
      mimeType: "",
      sizeBytes: 0,
    })),
  };
}

/** Apply the thread read caps to messages already ordered oldest first. */
function boundOldestFirst(messages: Message[]): Message[] {
  return boundThreadMessages([...messages].reverse());
}

/**
 * Load one conversation for classification: its newest messages within the
 * thread read caps. Combines the conversation row and its messages so the
 * read path does not pay two round trips per thread.
 */
export async function loadConversation(
  conversationId: string,
): Promise<Conversation | null> {
  const rows = await inBoundedRead(THREAD_READ_STATEMENT_TIMEOUT_MS, (client) =>
    client.query<
      MessageReadRow & {
        provider_conversation_id: string;
        subject: string | null;
        last_message_at: string | Date | null;
      }
    >(
      `select c.provider_conversation_id,
              c.subject,
              c.last_message_at,
              ${MESSAGES_FOR_READ_SQL}
         from seer.conversations c
         left join lateral (
           select id
             from seer.messages
            where conversation_id = c.id
            order by sent_at desc nulls first, provider_message_id desc
            limit $2
         ) page on true
         left join seer.messages m on m.id = page.id
        where c.id = $1
        order by m.sent_at asc nulls last, m.provider_message_id asc`,
      [conversationId, THREAD_READ_MESSAGE_CAP],
    ),
  );
  if ((rows.rowCount ?? 0) === 0) return null;
  const head = rows.rows[0];
  const messages: Message[] = [];
  for (const row of rows.rows) {
    const message = messageFromReadRow(row);
    if (message) messages.push(message);
  }
  return {
    providerConversationId: head.provider_conversation_id,
    subject: head.subject ?? "",
    lastMessageAt: iso(head.last_message_at),
    messages: boundOldestFirst(messages),
  };
}

/** Conversations per messages statement, so each stays well inside the read timeout. */
const STORED_CONVERSATION_BATCH = 200;

/**
 * Load every stored conversation for an account (shadow rebuild), each capped
 * like a single thread read. Messages are fetched in batches of conversations
 * so a 10k-thread mailbox is neither 10k round trips nor one unbounded scan.
 */
export async function loadStoredConversations(
  accountId: AccountId,
): Promise<{ conversationId: string; conversation: Conversation }[]> {
  return inBoundedRead(THREAD_READ_STATEMENT_TIMEOUT_MS, async (client) => {
    const convs = await client.query<{
      id: string;
      provider_conversation_id: string;
      subject: string | null;
      last_message_at: string | Date | null;
    }>(
      `select id, provider_conversation_id, subject, last_message_at
         from seer.conversations
        where account_id = $1 and is_deleted = false`,
      [accountId],
    );
    if ((convs.rowCount ?? 0) === 0) return [];
    const ids = convs.rows.map((c) => c.id);
    const byConv = new Map<string, Message[]>();
    for (let start = 0; start < ids.length; start += STORED_CONVERSATION_BATCH) {
      const batch = ids.slice(start, start + STORED_CONVERSATION_BATCH);
      const msgs = await client.query<MessageReadRow & { conversation_id: string }>(
        `with ranked as (
           select id,
                  row_number() over (
                    partition by conversation_id
                    order by sent_at desc nulls first, provider_message_id desc
                  ) as rn
             from seer.messages
            where conversation_id = any($1::uuid[])
         )
         select m.conversation_id, ${MESSAGES_FOR_READ_SQL}
           from ranked r
           join seer.messages m on m.id = r.id
          where r.rn <= $2
          order by m.sent_at asc nulls last, m.provider_message_id asc`,
        [batch, THREAD_READ_MESSAGE_CAP],
      );
      for (const row of msgs.rows) {
        const message = messageFromReadRow(row);
        if (!message) continue;
        const list = byConv.get(row.conversation_id) ?? [];
        list.push(message);
        byConv.set(row.conversation_id, list);
      }
    }
    return convs.rows.map((c) => ({
      conversationId: c.id,
      conversation: {
        providerConversationId: c.provider_conversation_id,
        subject: c.subject ?? "",
        lastMessageAt: iso(c.last_message_at),
        messages: boundOldestFirst(byConv.get(c.id) ?? []),
      },
    }));
  });
}
