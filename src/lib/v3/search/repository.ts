import { db } from "@/lib/v2/db/pool";
import type { AccountId } from "@/lib/v2/db/types";
import type { MailProvider } from "@/lib/v2/providers/types";

export type SearchRow = {
  providerConversationId: string;
  subject: string;
  snippet: string;
  lastMessageAt: string;
  synced: boolean;
  transient: boolean;
  conversationId?: string;
  decisionSummary: string | null;
  matterTitle: string | null;
  priority: number | null;
  dueDate: string | null;
};

export type SearchView = {
  rows: SearchRow[];
  nextCursor: string | null;
};

type MetadataRow = {
  provider_conversation_id: string;
  conversation_id: string;
  decision_summary: string | null;
  matter_title: string | null;
  priority: number | null;
  due_date: string | Date | null;
};

function isoDate(value: string | Date | null): string | null {
  if (!value) return null;
  const text = value instanceof Date ? value.toISOString() : String(value);
  return text.slice(0, 10);
}

/**
 * Search the provider and join stored decision/matter metadata by provider
 * conversation id. Results not yet synced to the corpus are marked transient.
 */
export async function searchWithMetadata(
  accountId: AccountId,
  provider: MailProvider,
  query: string,
  cursor: string | null,
): Promise<SearchView> {
  const page = await provider.search(query, cursor);
  if (page.conversations.length === 0) {
    return { rows: [], nextCursor: page.nextCursor };
  }

  const providerIds = page.conversations.map((c) => c.providerConversationId);
  const meta = await db().query<MetadataRow>(
    `select c.provider_conversation_id,
            c.id as conversation_id,
            d.summary as decision_summary,
            mt.title as matter_title,
            d.priority,
            d.due_date
       from seer.conversations c
       left join seer.conversation_decisions d
         on d.conversation_id = c.id
        and d.is_current
        and d.account_id = $1
       left join seer.matters mt
         on mt.id = d.matter_id
        and mt.account_id = $1
      where c.account_id = $1
        and c.is_deleted = false
        and c.provider_conversation_id = any($2::text[])`,
    [accountId, providerIds],
  );
  const byProvider = new Map(meta.rows.map((row) => [row.provider_conversation_id, row]));

  const rows: SearchRow[] = page.conversations.map((convo) => {
    const last = convo.messages[convo.messages.length - 1];
    const stored = byProvider.get(convo.providerConversationId);
    const synced = Boolean(stored);
    return {
      providerConversationId: convo.providerConversationId,
      subject: convo.subject,
      snippet: last?.snippet ?? "",
      lastMessageAt: convo.lastMessageAt,
      synced,
      transient: !synced,
      conversationId: stored?.conversation_id,
      decisionSummary: stored?.decision_summary ?? null,
      matterTitle: stored?.matter_title ?? null,
      priority: stored?.priority ?? null,
      dueDate: isoDate(stored?.due_date ?? null),
    };
  });

  return { rows, nextCursor: page.nextCursor };
}
