import type { PoolClient } from "pg";
import { db } from "../db/pool";
import { inTransaction } from "../db/transaction";
import type { AccountId } from "../db/types";
import type { Conversation, SyncFolder } from "../providers/types";

/**
 * Persistence for the sync engine. One page of conversations is written in a
 * single transaction so a crash mid-page leaves no partial thread. The cursor
 * is saved by the engine only after the page transaction commits.
 */

export type PageWriteResult = { stored: number; failed: number };

export async function writeConversationPage(
  accountId: AccountId,
  folder: SyncFolder,
  conversations: Conversation[],
  deletedProviderIds: string[],
): Promise<PageWriteResult> {
  return inTransaction(async (client) => {
    let stored = 0;
    let failed = 0;
    for (const convo of conversations) {
      try {
        await writeConversation(client, accountId, folder, convo);
        stored++;
      } catch {
        // A single malformed conversation must not sink the page; it is
        // counted as failed and retried on the next sync.
        failed++;
      }
    }
    for (const providerId of deletedProviderIds) {
      await client.query(
        `update seer.conversations set is_deleted = true, updated_at = now()
           where account_id = $1 and provider_conversation_id = $2`,
        [accountId, providerId],
      );
    }
    return { stored, failed };
  });
}

async function writeConversation(
  client: PoolClient,
  accountId: AccountId,
  folder: SyncFolder,
  convo: Conversation,
): Promise<void> {
  const isUnread = convo.messages.some((m) => m.isUnread);
  const conv = await client.query<{ id: string }>(
    `insert into seer.conversations
       (account_id, provider_conversation_id, subject, last_message_at, message_count,
        is_deleted, folders, is_unread, last_synced_at, updated_at)
       values ($1, $2, $3, $4, $5, false, array[$6]::text[], $7, now(), now())
       on conflict (account_id, provider_conversation_id) do update
         set subject = excluded.subject,
             last_message_at = excluded.last_message_at,
             message_count = excluded.message_count,
             is_deleted = false,
             folders = (
               select coalesce(array_agg(distinct f), '{}')
                 from unnest(seer.conversations.folders || array[$6]::text[]) as f
             ),
             is_unread = (
               select coalesce(bool_or(m.is_unread), false)
                 from seer.messages m
                where m.conversation_id = seer.conversations.id
             ),
             last_synced_at = now(),
             updated_at = now()
       returning id`,
    [
      accountId,
      convo.providerConversationId,
      convo.subject,
      convo.lastMessageAt || null,
      convo.messages.length,
      folder,
      isUnread,
    ],
  );
  const conversationId = conv.rows[0].id;
  for (const m of convo.messages) {
    await client.query(
      `insert into seer.messages
         (account_id, conversation_id, provider_message_id, from_email, from_name,
          to_emails, cc_emails, sent_at, snippet, body_html, body_text, is_unread,
          is_outgoing, attachment_names)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
         on conflict (account_id, provider_message_id) do update
           set body_html = excluded.body_html,
               body_text = excluded.body_text,
               is_unread = excluded.is_unread,
               attachment_names = excluded.attachment_names`,
      [
        accountId,
        conversationId,
        m.providerMessageId,
        m.from.email || null,
        m.from.name || null,
        m.to.map((a) => a.email),
        m.cc.map((a) => a.email),
        m.sentAt || null,
        m.snippet,
        m.bodyHtml,
        m.bodyText,
        m.isUnread,
        m.isOutgoing,
        m.attachments.map((a) => a.filename),
      ],
    );
  }

  await client.query(
    `update seer.conversations c
        set is_unread = (
          select coalesce(bool_or(m.is_unread), false)
            from seer.messages m
           where m.conversation_id = c.id
        )
      where c.id = $1`,
    [conversationId],
  );
}

export async function saveFolderCursor(
  accountId: AccountId,
  folder: SyncFolder,
  cursor: string | null,
  providerTotal: number,
): Promise<void> {
  await db().query(
    `insert into seer.folder_sync_state (account_id, folder, cursor, provider_total, updated_at)
       values ($1, $2, $3, $4, now())
       on conflict (account_id, folder) do update
         set cursor = excluded.cursor,
             provider_total = excluded.provider_total,
             updated_at = now()`,
    [accountId, folder, cursor, providerTotal],
  );
}

export async function hasFolderSyncState(
  accountId: AccountId,
  folder: SyncFolder,
): Promise<boolean> {
  const r = await db().query(
    "select 1 from seer.folder_sync_state where account_id = $1 and folder = $2",
    [accountId, folder],
  );
  return (r.rowCount ?? 0) > 0;
}

export async function loadFolderCursor(
  accountId: AccountId,
  folder: SyncFolder,
): Promise<string | null> {
  const r = await db().query<{ cursor: string | null }>(
    "select cursor from seer.folder_sync_state where account_id = $1 and folder = $2",
    [accountId, folder],
  );
  if ((r.rowCount ?? 0) > 0) return r.rows[0].cursor ?? null;
  if (folder === "inbox") return loadCursor(accountId);
  return null;
}

/** Legacy inbox cursor table — retained until full cutover to folder_sync_state. */
export async function saveCursor(
  accountId: AccountId,
  cursor: string | null,
  providerTotal: number,
): Promise<void> {
  await db().query(
    `insert into seer.sync_state (account_id, cursor, provider_total, updated_at)
       values ($1, $2, $3, now())
       on conflict (account_id) do update
         set cursor = excluded.cursor,
             provider_total = excluded.provider_total,
             updated_at = now()`,
    [accountId, cursor, providerTotal],
  );
}

export async function loadCursor(accountId: AccountId): Promise<string | null> {
  const r = await db().query<{ cursor: string | null }>(
    "select cursor from seer.sync_state where account_id = $1",
    [accountId],
  );
  return r.rows[0]?.cursor ?? null;
}

export type Coverage = {
  providerTotal: number;
  stored: number;
  pending: number;
  failed: number;
};

/** Reconcile what we hold against the provider's own total for one folder. */
export async function folderCoverage(
  accountId: AccountId,
  folder: SyncFolder,
): Promise<Coverage> {
  const state = await db().query<{ provider_total: number }>(
    "select provider_total from seer.folder_sync_state where account_id = $1 and folder = $2",
    [accountId, folder],
  );
  const stored = await db().query<{ n: number }>(
    `select count(*)::int as n
       from seer.conversations
      where account_id = $1
        and is_deleted = false
        and folders @> array[$2]::text[]`,
    [accountId, folder],
  );
  const providerTotal = state.rows[0]?.provider_total ?? 0;
  const storedCount = stored.rows[0]?.n ?? 0;
  return {
    providerTotal,
    stored: storedCount,
    pending: Math.max(0, providerTotal - storedCount),
    failed: 0,
  };
}

/** Reconcile what we hold against the provider's own total (legacy inbox path). */
export async function coverage(accountId: AccountId): Promise<Coverage> {
  return folderCoverage(accountId, "inbox");
}
