import { db } from "../db/pool";
import type { AccountId, ConversationId } from "../db/types";
import {
  detectDrift,
  inferStyle,
  isClearHabit,
  isMatterBar,
  normalizeCues,
  styleGuidance,
  type ClearHabit,
  type DriftSignal,
  type ImportanceCue,
  type MailboxSnapshot,
  type MailboxStyleFields,
  type MatterBar,
  type StyleInference,
} from "./mailbox-style";

export type StoredMailboxStyle = MailboxStyleFields & {
  confirmed: boolean;
  inferred: StyleInference;
  driftPrompt: string | null;
  confirmedAt: string | null;
  updatedAt: string;
  snapshot: MailboxSnapshot;
};

type StyleRow = {
  clear_habit: string;
  importance_cues: string[];
  matter_bar: string;
  confirmed: boolean;
  inferred: StyleInference | Record<string, unknown>;
  drift_prompt: string | null;
  confirmed_at: Date | string | null;
  updated_at: Date | string;
};

function asInference(value: StyleInference | Record<string, unknown>): StyleInference {
  const record = value as Partial<StyleInference>;
  if (
    record &&
    isClearHabit(String(record.clearHabit ?? "")) &&
    Array.isArray(record.importanceCues) &&
    isMatterBar(String(record.matterBar ?? ""))
  ) {
    return {
      clearHabit: record.clearHabit as ClearHabit,
      importanceCues: normalizeCues(record.importanceCues as string[]),
      matterBar: record.matterBar as MatterBar,
      confidence: Number(record.confidence ?? 0),
      reasons: Array.isArray(record.reasons)
        ? record.reasons.map(String)
        : [],
    };
  }
  return inferStyle(emptySnapshot());
}

function emptySnapshot(): MailboxSnapshot {
  return {
    providerInboxTotal: 0,
    storedInbox: 0,
    unreadInbox: 0,
    starredOrFlagged: 0,
    trashCount: 0,
    sentCount: 0,
    recentUserArchives: 0,
    recentUserDeletes: 0,
    openMatters: 0,
  };
}

function iso(value: Date | string | null): string | null {
  if (!value) return null;
  return value instanceof Date ? value.toISOString() : String(value);
}

export async function loadMailboxSnapshot(
  accountId: AccountId,
): Promise<MailboxSnapshot> {
  const [totals, actions, matters] = await Promise.all([
    db().query<{
      provider_inbox: number;
      stored_inbox: number;
      unread_inbox: number;
      trash_count: number;
      sent_count: number;
    }>(
      `select
         coalesce((
           select provider_total from seer.folder_sync_state
            where account_id = $1 and folder = 'inbox'
         ), (
           select provider_total from seer.sync_state
            where account_id = $1
         ), 0)::int as provider_inbox,
         (select count(*)::int from seer.conversations
           where account_id = $1 and is_deleted = false
             and folders @> array['inbox']::text[]) as stored_inbox,
         (select count(*)::int from seer.conversations
           where account_id = $1 and is_deleted = false
             and folders @> array['inbox']::text[]
             and is_unread = true) as unread_inbox,
         (select count(*)::int from seer.conversations
           where account_id = $1
             and folders @> array['trash']::text[]) as trash_count,
         (select count(*)::int from seer.conversations
           where account_id = $1
             and folders @> array['sent']::text[]) as sent_count`,
      [accountId],
    ),
    db().query<{ archives: number; deletes: number }>(
      `select
         count(*) filter (where command->>'type' = 'archive')::int as archives,
         count(*) filter (where command->>'type' = 'trash')::int as deletes
         from seer.outbox
        where account_id = $1
          and created_at > now() - interval '30 days'`,
      [accountId],
    ),
    db().query<{ n: number }>(
      `select count(*)::int as n from seer.matters
        where account_id = $1 and status <> 'closed'`,
      [accountId],
    ),
  ]);
  const row = totals.rows[0];
  return {
    providerInboxTotal: row?.provider_inbox ?? 0,
    storedInbox: row?.stored_inbox ?? 0,
    unreadInbox: row?.unread_inbox ?? 0,
    starredOrFlagged: 0,
    trashCount: row?.trash_count ?? 0,
    sentCount: row?.sent_count ?? 0,
    recentUserArchives: actions.rows[0]?.archives ?? 0,
    recentUserDeletes: actions.rows[0]?.deletes ?? 0,
    openMatters: matters.rows[0]?.n ?? 0,
  };
}

function mapRow(row: StyleRow, snapshot: MailboxSnapshot): StoredMailboxStyle {
  return {
    clearHabit: isClearHabit(row.clear_habit) ? row.clear_habit : "archive",
    importanceCues: normalizeCues(row.importance_cues ?? []),
    matterBar: isMatterBar(row.matter_bar) ? row.matter_bar : "medium",
    confirmed: row.confirmed,
    inferred: asInference(row.inferred),
    driftPrompt: row.drift_prompt,
    confirmedAt: iso(row.confirmed_at),
    updatedAt: iso(row.updated_at) ?? new Date().toISOString(),
    snapshot,
  };
}

export async function loadMailboxStyle(
  accountId: AccountId,
): Promise<StoredMailboxStyle | null> {
  const [row, snapshot] = await Promise.all([
    db().query<StyleRow>(
      `select clear_habit, importance_cues, matter_bar, confirmed, inferred,
              drift_prompt, confirmed_at, updated_at
         from seer.mailbox_styles where account_id = $1`,
      [accountId],
    ),
    loadMailboxSnapshot(accountId),
  ]);
  if (!row.rows[0]) return null;
  return mapRow(row.rows[0], snapshot);
}

export async function refreshMailboxInference(
  accountId: AccountId,
): Promise<StoredMailboxStyle> {
  const snapshot = await loadMailboxSnapshot(accountId);
  const inferred = inferStyle(snapshot);
  const existing = await db().query<StyleRow>(
    `select clear_habit, importance_cues, matter_bar, confirmed, inferred,
            drift_prompt, confirmed_at, updated_at
       from seer.mailbox_styles where account_id = $1`,
    [accountId],
  );
  if (!existing.rows[0]) {
    const inserted = await db().query<StyleRow>(
      `insert into seer.mailbox_styles
         (account_id, clear_habit, importance_cues, matter_bar, confirmed, inferred)
       values ($1, $2, $3, $4, false, $5::jsonb)
       returning clear_habit, importance_cues, matter_bar, confirmed, inferred,
                 drift_prompt, confirmed_at, updated_at`,
      [
        accountId,
        inferred.clearHabit,
        inferred.importanceCues,
        inferred.matterBar,
        JSON.stringify(inferred),
      ],
    );
    return mapRow(inserted.rows[0], snapshot);
  }
  if (existing.rows[0].confirmed) {
    await db().query(
      `update seer.mailbox_styles
          set inferred = $2::jsonb, updated_at = now()
        where account_id = $1`,
      [accountId, JSON.stringify(inferred)],
    );
    return mapRow({ ...existing.rows[0], inferred }, snapshot);
  }
  const updated = await db().query<StyleRow>(
    `update seer.mailbox_styles
        set clear_habit = $2,
            importance_cues = $3,
            matter_bar = $4,
            inferred = $5::jsonb,
            updated_at = now()
      where account_id = $1
      returning clear_habit, importance_cues, matter_bar, confirmed, inferred,
                drift_prompt, confirmed_at, updated_at`,
    [
      accountId,
      inferred.clearHabit,
      inferred.importanceCues,
      inferred.matterBar,
      JSON.stringify(inferred),
    ],
  );
  return mapRow(updated.rows[0], snapshot);
}

export async function confirmMailboxStyle(
  accountId: AccountId,
  fields: MailboxStyleFields,
): Promise<StoredMailboxStyle> {
  const snapshot = await loadMailboxSnapshot(accountId);
  const inferred = inferStyle(snapshot);
  const cues = normalizeCues(fields.importanceCues);
  const updated = await db().query<StyleRow>(
    `insert into seer.mailbox_styles
       (account_id, clear_habit, importance_cues, matter_bar, confirmed,
        inferred, drift_prompt, confirmed_at, updated_at)
     values ($1, $2, $3, $4, true, $5::jsonb, null, now(), now())
     on conflict (account_id) do update set
       clear_habit = excluded.clear_habit,
       importance_cues = excluded.importance_cues,
       matter_bar = excluded.matter_bar,
       confirmed = true,
       inferred = excluded.inferred,
       drift_prompt = null,
       confirmed_at = now(),
       updated_at = now()
     returning clear_habit, importance_cues, matter_bar, confirmed, inferred,
               drift_prompt, confirmed_at, updated_at`,
    [
      accountId,
      fields.clearHabit,
      cues,
      fields.matterBar,
      JSON.stringify(inferred),
    ],
  );
  await recordTrainingEvent(accountId, null, "confirm_style", {
    clearHabit: fields.clearHabit,
    importanceCues: cues,
    matterBar: fields.matterBar,
  });
  return mapRow(updated.rows[0], snapshot);
}

export async function dismissStyleDrift(accountId: AccountId): Promise<void> {
  await db().query(
    `update seer.mailbox_styles
        set drift_prompt = null, updated_at = now()
      where account_id = $1`,
    [accountId],
  );
  await recordTrainingEvent(accountId, null, "dismiss_drift", {});
}

export async function recordTrainingEvent(
  accountId: AccountId,
  conversationId: string | null,
  kind: "confirm_style" | "relevance" | "triage" | "dismiss_drift",
  payload: Record<string, unknown>,
): Promise<void> {
  await db().query(
    `insert into seer.training_events (account_id, conversation_id, kind, payload)
     values ($1, $2, $3, $4::jsonb)`,
    [accountId, conversationId, kind, JSON.stringify(payload)],
  );
  await refreshDrift(accountId);
}

async function refreshDrift(accountId: AccountId): Promise<void> {
  const style = await db().query<StyleRow>(
    `select clear_habit, importance_cues, matter_bar, confirmed, inferred,
            drift_prompt, confirmed_at, updated_at
       from seer.mailbox_styles where account_id = $1`,
    [accountId],
  );
  const row = style.rows[0];
  if (!row?.confirmed) return;
  const events = await db().query<{ payload: DriftSignal }>(
    `select payload from seer.training_events
      where account_id = $1 and kind in ('relevance', 'triage')
      order by created_at desc
      limit 12`,
    [accountId],
  );
  const prompt = detectDrift(
    {
      clearHabit: isClearHabit(row.clear_habit) ? row.clear_habit : "archive",
      importanceCues: normalizeCues(row.importance_cues),
      matterBar: isMatterBar(row.matter_bar) ? row.matter_bar : "medium",
      confirmed: true,
    },
    events.rows.map((item) => item.payload),
  );
  await db().query(
    `update seer.mailbox_styles
        set drift_prompt = $2, updated_at = now()
      where account_id = $1`,
    [accountId, prompt],
  );
}

export async function setFocusHidden(
  accountId: AccountId,
  conversationId: ConversationId | string,
  hidden: boolean,
): Promise<void> {
  await db().query(
    `update seer.conversations
        set focus_hidden = $3, updated_at = now()
      where id = $1 and account_id = $2`,
    [conversationId, accountId, hidden],
  );
}

export async function closeLinkedMatter(
  accountId: AccountId,
  conversationId: string,
): Promise<void> {
  await db().query(
    `update seer.matters m
        set status = 'closed', updated_at = now()
       from seer.conversation_decisions d
      where d.account_id = $1
        and d.conversation_id = $2
        and d.is_current
        and d.matter_id = m.id
        and m.account_id = $1
        and m.status <> 'closed'`,
    [accountId, conversationId],
  );
}

export function effectiveStyle(
  stored: StoredMailboxStyle | null,
): MailboxStyleFields {
  if (!stored) {
    return {
      clearHabit: "archive",
      importanceCues: ["none"],
      matterBar: "medium",
    };
  }
  return {
    clearHabit: stored.clearHabit,
    importanceCues: stored.importanceCues,
    matterBar: stored.matterBar,
  };
}

export function guidanceFor(stored: StoredMailboxStyle | null): string {
  return stored ? styleGuidance(effectiveStyle(stored)) : "";
}

export type { ImportanceCue };
