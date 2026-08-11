import type { PoolClient } from "pg";
import { db } from "../db/pool";
import { inTransaction } from "../db/transaction";
import type { AccountId } from "../db/types";
import { getSyncMask } from "../../v3/outbox/sync-mask";
import type { Conversation, SyncFolder } from "../providers/types";

/**
 * Persistence for the sync engine. One page of conversations is written in a
 * single transaction so a crash mid-page leaves no partial thread. The cursor
 * is saved by the engine only after the page transaction commits.
 */

export type PageWriteResult = { stored: number; failed: number };

export type FolderSyncState = {
  cursor: string | null;
  backfillComplete: boolean;
  providerTotal: number;
  scanGeneration: number;
  scanStartedAt: Date | null;
  lastReconciledAt: Date | null;
};

export async function writeConversationPage(
  accountId: AccountId,
  folder: SyncFolder,
  conversations: Conversation[],
  deletedProviderIds: string[],
  scanGeneration?: number,
): Promise<PageWriteResult> {
  return inTransaction(async (client) => {
    let stored = 0;
    let failed = 0;
    for (const [index, convo] of conversations.entries()) {
      const savepoint = `v3_conversation_row_${index}`;
      if (scanGeneration !== undefined) {
        // Record provider visibility outside the row savepoint. If hydration
        // is malformed, the conversation was still observed in this
        // authoritative snapshot and must not be removed as stale.
        await client.query(
          `insert into seer.folder_sync_seen
             (account_id, folder, scan_generation, provider_conversation_id)
           values ($1, $2, $3, $4)
           on conflict do nothing`,
          [accountId, folder, scanGeneration, convo.providerConversationId],
        );
      }
      await client.query(`savepoint ${savepoint}`);
      try {
        await writeConversation(client, accountId, folder, convo);
        await client.query(`release savepoint ${savepoint}`);
        stored++;
      } catch {
        // A single malformed conversation must not sink the page; it is
        // counted as failed and retried on the next sync.
        await client.query(`rollback to savepoint ${savepoint}`);
        await client.query(`release savepoint ${savepoint}`);
        failed++;
      }
    }
    for (const providerId of deletedProviderIds) {
      await client.query(
        `update seer.conversations
            set folders = array_remove(folders, $3::text),
                is_deleted = case when $3::text = 'inbox' then true else is_deleted end,
                updated_at = now()
           where account_id = $1 and provider_conversation_id = $2`,
        [accountId, providerId, folder],
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
  const mask = await getSyncMask(
    client,
    accountId,
    conversationId,
    convo.lastMessageAt || null,
  );
  if (!mask.blockedFolders.has(folder)) {
    await client.query(
      `update seer.conversations
          set folders = (
                select coalesce(array_agg(distinct f), '{}')
                  from unnest(folders || array[$2]::text[]) as f
              ),
              updated_at = now()
        where id = $1`,
      [conversationId, folder],
    );
  }
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

  if (!mask.protectUnread) {
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
}

export async function saveFolderSyncState(
  accountId: AccountId,
  folder: SyncFolder,
  state: FolderSyncState,
): Promise<void> {
  await db().query(
    `insert into seer.folder_sync_state
       (account_id, folder, cursor, provider_total, backfill_complete,
        scan_generation, scan_started_at, last_reconciled_at, updated_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, now())
       on conflict (account_id, folder) do update
         set cursor = excluded.cursor,
             provider_total = excluded.provider_total,
             backfill_complete = excluded.backfill_complete,
             scan_generation = excluded.scan_generation,
             scan_started_at = excluded.scan_started_at,
             last_reconciled_at = excluded.last_reconciled_at,
             updated_at = now()`,
    [
      accountId,
      folder,
      state.cursor,
      state.providerTotal,
      state.backfillComplete,
      state.scanGeneration,
      state.scanStartedAt,
      state.lastReconciledAt,
    ],
  );
}

/** Start a durable provider snapshot. Old seen rows are disposable because a
 * generation is the complete membership set for one folder scan. */
export async function beginFolderSnapshot(
  accountId: AccountId,
  folder: SyncFolder,
): Promise<FolderSyncState> {
  return inTransaction(async (client) => {
    const current = await client.query<{
      provider_total: number;
      scan_generation: string | number;
      last_reconciled_at: Date | null;
    }>(
      `select provider_total, scan_generation, last_reconciled_at
         from seer.folder_sync_state
        where account_id = $1 and folder = $2
        for update`,
      [accountId, folder],
    );
    const previous = current.rows[0];
    const generation = Number(previous?.scan_generation ?? 0) + 1;
    const startedAt = new Date();
    await client.query(
      `delete from seer.folder_sync_seen
        where account_id = $1 and folder = $2`,
      [accountId, folder],
    );
    await client.query(
      `insert into seer.folder_sync_state
         (account_id, folder, cursor, provider_total, backfill_complete,
          scan_generation, scan_started_at, last_reconciled_at, updated_at)
       values ($1, $2, null, $3, false, $4, $5, $6, now())
       on conflict (account_id, folder) do update
         set cursor = null,
             provider_total = excluded.provider_total,
             backfill_complete = false,
             scan_generation = excluded.scan_generation,
             scan_started_at = excluded.scan_started_at,
             last_reconciled_at = excluded.last_reconciled_at,
             updated_at = now()`,
      [
        accountId,
        folder,
        previous?.provider_total ?? 0,
        generation,
        startedAt,
        previous?.last_reconciled_at ?? null,
      ],
    );
    return {
      cursor: null,
      providerTotal: previous?.provider_total ?? 0,
      backfillComplete: false,
      scanGeneration: generation,
      scanStartedAt: startedAt,
      lastReconciledAt: previous?.last_reconciled_at ?? null,
    };
  });
}

/** Atomically remove stale membership and publish the completed snapshot. */
export async function completeFolderSnapshot(
  accountId: AccountId,
  folder: SyncFolder,
  generation: number,
  providerTotal: number,
): Promise<void> {
  await inTransaction(async (client) => {
    await client.query(
      `update seer.conversations c
          set folders = coalesce((
                select array_agg(distinct f order by f)
                  from unnest(array_remove(c.folders, $2::text)) as f
              ), '{}'::text[]),
              updated_at = now()
        where c.account_id = $1
          and c.folders @> array[$2::text]
          and not exists (
            select 1
              from seer.folder_sync_seen s
             where s.account_id = c.account_id
               and s.folder = $2
               and s.scan_generation = $3
               and s.provider_conversation_id = c.provider_conversation_id
          )`,
      [accountId, folder, generation],
    );
    await client.query(
      `update seer.folder_sync_state
          set cursor = null,
              provider_total = $4,
              backfill_complete = true,
              last_reconciled_at = now(),
              updated_at = now()
        where account_id = $1 and folder = $2 and scan_generation = $3`,
      [accountId, folder, generation, providerTotal],
    );
  });
}

/** @deprecated Use saveFolderSyncState */
export async function saveFolderCursor(
  accountId: AccountId,
  folder: SyncFolder,
  cursor: string | null,
  providerTotal: number,
): Promise<void> {
  await saveFolderSyncState(accountId, folder, {
    cursor,
    providerTotal,
    backfillComplete: cursor === null && providerTotal > 0,
    scanGeneration: 0,
    scanStartedAt: null,
    lastReconciledAt: null,
  });
}

export async function loadFolderSyncState(
  accountId: AccountId,
  folder: SyncFolder,
): Promise<FolderSyncState> {
  const r = await db().query<{
    cursor: string | null;
    provider_total: number;
    backfill_complete: boolean;
    scan_generation: string | number;
    scan_started_at: Date | null;
    last_reconciled_at: Date | null;
  }>(
    `select cursor, provider_total, backfill_complete, scan_generation,
            scan_started_at, last_reconciled_at
       from seer.folder_sync_state
      where account_id = $1 and folder = $2`,
    [accountId, folder],
  );
  if ((r.rowCount ?? 0) > 0) {
    const row = r.rows[0];
    return {
      cursor: row.cursor ?? null,
      backfillComplete: row.backfill_complete,
      providerTotal: row.provider_total,
      scanGeneration: Number(row.scan_generation ?? 0),
      scanStartedAt: row.scan_started_at,
      lastReconciledAt: row.last_reconciled_at,
    };
  }

  if (folder === "inbox") {
    const legacy = await db().query<{
      cursor: string | null;
      provider_total: number;
    }>("select cursor, provider_total from seer.sync_state where account_id = $1", [
      accountId,
    ]);
    if ((legacy.rowCount ?? 0) > 0) {
      const row = legacy.rows[0];
      return {
        cursor: row.cursor ?? null,
        providerTotal: row.provider_total,
        backfillComplete: row.cursor === null && row.provider_total > 0,
        // A legacy cursor is already in the middle of a historical scan. Give
        // it a generation so the first resumed page can participate in the
        // durable snapshot without incorrectly restarting at page one.
        scanGeneration: row.cursor === null ? 0 : 1,
        scanStartedAt: row.cursor === null ? null : new Date(),
        lastReconciledAt: null,
      };
    }
  }

  return {
    cursor: null,
    backfillComplete: false,
    providerTotal: 0,
    scanGeneration: 0,
    scanStartedAt: null,
    lastReconciledAt: null,
  };
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
  const state = await loadFolderSyncState(accountId, folder);
  if (state.backfillComplete) return null;
  return state.cursor;
}

/** Legacy inbox cursor table — retained until full cutover to folder_sync_state. */
export async function saveCursor(
  accountId: AccountId,
  cursor: string | null,
  providerTotal: number,
  backfillComplete = false,
): Promise<void> {
  await db().query(
    `insert into seer.sync_state (account_id, cursor, provider_total, updated_at)
       values ($1, $2, $3, now())
       on conflict (account_id) do update
         set cursor = excluded.cursor,
             provider_total = excluded.provider_total,
             updated_at = now()`,
    [accountId, backfillComplete ? null : cursor, providerTotal],
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
