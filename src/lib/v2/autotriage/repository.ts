import { db } from "../db/pool";
import { isUuid, type AccountId } from "../db/types";
import type {
  AutoTriageAction,
  AutoTriageAuditGroup,
  AutoTriageDecider,
  AutoTriageLogRow,
  AutoTriageMode,
  AutoTriageSettings,
} from "./types";

function iso(value: Date | string | null | undefined): string | null {
  if (!value) return null;
  return value instanceof Date ? value.toISOString() : String(value);
}

function requireIso(value: Date | string): string {
  return iso(value) ?? new Date().toISOString();
}

type SettingsRow = {
  account_id: string;
  mode: AutoTriageMode;
  ai_enabled: boolean;
  ai_auto_threshold: string | number;
  updated_at: Date;
};

function asSettings(row: SettingsRow): AutoTriageSettings {
  return {
    accountId: row.account_id,
    mode: row.mode,
    aiEnabled: row.ai_enabled,
    aiAutoThreshold: Number(row.ai_auto_threshold),
    updatedAt: requireIso(row.updated_at),
  };
}

export async function ensureSettings(accountId: AccountId): Promise<AutoTriageSettings> {
  const r = await db().query<SettingsRow>(
    `insert into seer.autotriage_settings (account_id)
     values ($1)
     on conflict (account_id) do update set account_id = excluded.account_id
     returning account_id, mode, ai_enabled, ai_auto_threshold, updated_at`,
    [accountId],
  );
  return asSettings(r.rows[0]);
}

export async function setAutoTriageMode(
  accountId: AccountId,
  mode: AutoTriageMode,
): Promise<AutoTriageSettings> {
  const r = await db().query<SettingsRow>(
    `insert into seer.autotriage_settings (account_id, mode, updated_at)
     values ($1, $2, now())
     on conflict (account_id) do update
       set mode = excluded.mode, updated_at = now()
     returning account_id, mode, ai_enabled, ai_auto_threshold, updated_at`,
    [accountId, mode],
  );
  return asSettings(r.rows[0]);
}

export async function setAiEnabled(
  accountId: AccountId,
  aiEnabled: boolean,
): Promise<AutoTriageSettings> {
  const r = await db().query<SettingsRow>(
    `insert into seer.autotriage_settings (account_id, ai_enabled, updated_at)
     values ($1, $2, now())
     on conflict (account_id) do update
       set ai_enabled = excluded.ai_enabled, updated_at = now()
     returning account_id, mode, ai_enabled, ai_auto_threshold, updated_at`,
    [accountId, aiEnabled],
  );
  return asSettings(r.rows[0]);
}

export async function getWatermark(accountId: AccountId): Promise<Date | null> {
  const r = await db().query<{ last_message_at: Date | null }>(
    "select last_message_at from seer.autotriage_state where account_id = $1",
    [accountId],
  );
  return r.rows[0]?.last_message_at ?? null;
}

export async function setWatermark(
  accountId: AccountId,
  lastMessageAt: Date | string | null,
): Promise<void> {
  await db().query(
    `insert into seer.autotriage_state (account_id, last_message_at, updated_at)
     values ($1, $2, now())
     on conflict (account_id) do update
       set last_message_at = excluded.last_message_at, updated_at = now()`,
    [accountId, lastMessageAt],
  );
}

export async function loadCorrespondents(accountId: AccountId): Promise<Set<string>> {
  const r = await db().query<{ addr: string }>(
    `select distinct lower(addr) as addr
       from seer.messages,
            unnest(to_emails || cc_emails) as addr
      where account_id = $1
        and is_outgoing
        and addr is not null
        and addr <> ''`,
    [accountId],
  );
  return new Set(r.rows.map((row) => row.addr));
}

export async function loadRepliedConversations(
  accountId: AccountId,
): Promise<Set<string>> {
  const r = await db().query<{ conversation_id: string }>(
    `select distinct conversation_id
       from seer.messages
      where account_id = $1 and is_outgoing`,
    [accountId],
  );
  return new Set(r.rows.map((row) => row.conversation_id));
}

export async function loadOpenThreadIds(accountId: AccountId): Promise<Set<string>> {
  const r = await db().query<{ conversation_id: string }>(
    `select distinct conversation_id
       from seer.messages
      where account_id = $1
        and is_outgoing
        and sent_at > now() - interval '60 days'
     union
     select mc.conversation_id
       from seer.matter_conversations mc
       join seer.matters m on m.id = mc.matter_id
      where m.account_id = $1
        and m.status = 'open'`,
    [accountId],
  );
  return new Set(r.rows.map((row) => row.conversation_id));
}

export async function loadAlwaysKeepSenders(accountId: AccountId): Promise<string[]> {
  const r = await db().query<{ sender: string }>(
    `select sender from seer.triage_sender_rules
      where account_id = $1 and kind = 'always_keep'`,
    [accountId],
  );
  return r.rows.map((row) => row.sender.toLowerCase());
}

export async function loadSenderOverrides(
  accountId: AccountId,
): Promise<Record<string, "delete" | "archive">> {
  const r = await db().query<{ sender: string; kind: "delete" | "archive" }>(
    `select sender, kind from seer.triage_sender_rules
      where account_id = $1 and kind in ('delete', 'archive')`,
    [accountId],
  );
  const out: Record<string, "delete" | "archive"> = {};
  for (const row of r.rows) out[row.sender.toLowerCase()] = row.kind;
  return out;
}

export async function upsertSenderRule(
  accountId: AccountId,
  sender: string,
  kind: "always_keep" | "delete" | "archive",
  source = "user",
): Promise<void> {
  await db().query(
    `insert into seer.triage_sender_rules (account_id, sender, kind, source)
     values ($1, $2, $3, $4)
     on conflict (account_id, sender) do update
       set kind = excluded.kind, source = excluded.source`,
    [accountId, sender.toLowerCase(), kind, source],
  );
}

export type CandidateMessage = {
  conversationId: string;
  providerConversationId: string;
  providerMessageId: string;
  senderEmail: string;
  subject: string;
  snippet: string | null;
  sentAt: string | null;
};

export async function listInboxCandidates(
  accountId: AccountId,
  conversationIds: string[],
  watermark: Date | null,
): Promise<CandidateMessage[]> {
  const ids = conversationIds.filter((id) => isUuid(id));
  if (ids.length === 0 && !watermark) return [];
  const r = await db().query<{
    conversation_id: string;
    provider_conversation_id: string;
    provider_message_id: string;
    from_email: string | null;
    subject: string | null;
    snippet: string | null;
    sent_at: Date | null;
  }>(
    `select c.id as conversation_id,
            c.provider_conversation_id,
            m.provider_message_id,
            m.from_email,
            c.subject,
            m.snippet,
            m.sent_at
       from seer.conversations c
       join lateral (
         select provider_message_id, from_email, snippet, sent_at
           from seer.messages
          where conversation_id = c.id
            and not is_outgoing
          order by sent_at desc nulls last
          limit 1
       ) m on true
      where c.account_id = $1
        and c.folders @> array['inbox']::text[]
        and (
          c.id = any($2::uuid[])
          or ($3::timestamptz is not null and m.sent_at > $3)
        )`,
    [accountId, ids, watermark],
  );
  return r.rows.map((row) => ({
    conversationId: row.conversation_id,
    providerConversationId: row.provider_conversation_id,
    providerMessageId: row.provider_message_id,
    senderEmail: (row.from_email ?? "").toLowerCase(),
    subject: row.subject ?? "",
    snippet: row.snippet,
    sentAt: iso(row.sent_at),
  }));
}

type LogRow = {
  id: string;
  account_id: string;
  conversation_id: string | null;
  provider_message_id: string;
  sender_email: string | null;
  subject: string | null;
  action: AutoTriageAction;
  proposed: string | null;
  rule: string | null;
  reason: string | null;
  decider: AutoTriageDecider;
  ai_confidence: string | number | null;
  mode: AutoTriageMode;
  outbox_id: string | null;
  proposal_id: string | null;
  undone_at: Date | null;
  undo_outbox_id: string | null;
  created_at: Date;
};

function asLog(row: LogRow): AutoTriageLogRow {
  return {
    id: row.id,
    accountId: row.account_id,
    conversationId: row.conversation_id,
    providerMessageId: row.provider_message_id,
    senderEmail: row.sender_email,
    subject: row.subject,
    action: row.action,
    proposed: row.proposed,
    rule: row.rule,
    reason: row.reason,
    decider: row.decider,
    aiConfidence: row.ai_confidence == null ? null : Number(row.ai_confidence),
    mode: row.mode,
    outboxId: row.outbox_id,
    proposalId: row.proposal_id,
    undoneAt: iso(row.undone_at),
    undoOutboxId: row.undo_outbox_id,
    createdAt: requireIso(row.created_at),
  };
}

export async function insertLog(input: {
  accountId: AccountId;
  conversationId?: string | null;
  providerMessageId: string;
  senderEmail?: string | null;
  subject?: string | null;
  action: AutoTriageAction;
  proposed?: string | null;
  rule?: string | null;
  reason?: string | null;
  decider: AutoTriageDecider;
  aiConfidence?: number | null;
  mode: AutoTriageMode | string;
  outboxId?: string | null;
  proposalId?: string | null;
}): Promise<AutoTriageLogRow | null> {
  const r = await db().query<LogRow>(
    `insert into seer.autotriage_log (
       account_id, conversation_id, provider_message_id, sender_email, subject,
       action, proposed, rule, reason, decider, ai_confidence, mode, outbox_id, proposal_id
     ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
     on conflict (account_id, provider_message_id) do nothing
     returning id, account_id, conversation_id, provider_message_id, sender_email, subject,
               action, proposed, rule, reason, decider, ai_confidence, mode, outbox_id,
               proposal_id, undone_at, undo_outbox_id, created_at`,
    [
      input.accountId,
      input.conversationId ?? null,
      input.providerMessageId,
      input.senderEmail ?? null,
      input.subject ?? null,
      input.action,
      input.proposed ?? null,
      input.rule ?? null,
      input.reason ?? null,
      input.decider,
      input.aiConfidence ?? null,
      input.mode,
      input.outboxId ?? null,
      input.proposalId ?? null,
    ],
  );
  return r.rows[0] ? asLog(r.rows[0]) : null;
}

export async function findLogByMessage(
  accountId: AccountId,
  providerMessageId: string,
): Promise<AutoTriageLogRow | null> {
  const r = await db().query<LogRow>(
    `select id, account_id, conversation_id, provider_message_id, sender_email, subject,
            action, proposed, rule, reason, decider, ai_confidence, mode, outbox_id,
            proposal_id, undone_at, undo_outbox_id, created_at
       from seer.autotriage_log
      where account_id = $1 and provider_message_id = $2`,
    [accountId, providerMessageId],
  );
  return r.rows[0] ? asLog(r.rows[0]) : null;
}

export async function getLog(
  accountId: AccountId,
  logId: string,
): Promise<AutoTriageLogRow | null> {
  if (!isUuid(logId)) return null;
  const r = await db().query<LogRow>(
    `select id, account_id, conversation_id, provider_message_id, sender_email, subject,
            action, proposed, rule, reason, decider, ai_confidence, mode, outbox_id,
            proposal_id, undone_at, undo_outbox_id, created_at
       from seer.autotriage_log
      where account_id = $1 and id = $2`,
    [accountId, logId],
  );
  return r.rows[0] ? asLog(r.rows[0]) : null;
}

export async function markLogUndone(
  accountId: AccountId,
  logId: string,
  undoOutboxId?: string | null,
): Promise<AutoTriageLogRow | null> {
  const r = await db().query<LogRow>(
    `update seer.autotriage_log
        set undone_at = now(),
            undo_outbox_id = coalesce($3, undo_outbox_id)
      where account_id = $1 and id = $2
      returning id, account_id, conversation_id, provider_message_id, sender_email, subject,
                action, proposed, rule, reason, decider, ai_confidence, mode, outbox_id,
                proposal_id, undone_at, undo_outbox_id, created_at`,
    [accountId, logId, undoOutboxId ?? null],
  );
  return r.rows[0] ? asLog(r.rows[0]) : null;
}

export async function pendingProposalExists(
  accountId: AccountId,
  conversationId: string,
): Promise<boolean> {
  const r = await db().query(
    `select 1 from seer.triage_proposals
      where account_id = $1 and conversation_id = $2 and status = 'pending'
      limit 1`,
    [accountId, conversationId],
  );
  return (r.rowCount ?? 0) > 0;
}

export async function loadAudit(
  accountId: AccountId,
  days = 7,
): Promise<AutoTriageAuditGroup[]> {
  const r = await db().query<{
    sender: string;
    count: string;
    delete_count: string;
    archive_count: string;
    keep_count: string;
    review_count: string;
    subjects: string[];
    rule: string | null;
    decider: string;
    latest_log_id: string;
    undone: boolean;
  }>(
    `select coalesce(nullif(sender_email, ''), '(unknown)') as sender,
            count(*)::text as count,
            count(*) filter (where action = 'delete')::text as delete_count,
            count(*) filter (where action = 'archive')::text as archive_count,
            count(*) filter (where action = 'keep')::text as keep_count,
            count(*) filter (where action in ('review','unknown','save-doc'))::text as review_count,
            (array_agg(subject order by created_at desc) filter (where subject is not null))[1:5] as subjects,
            (array_agg(rule order by created_at desc))[1] as rule,
            case when count(distinct decider) = 1 then min(decider) else 'mixed' end as decider,
            (array_agg(id order by created_at desc))[1] as latest_log_id,
            bool_and(undone_at is not null) as undone
       from seer.autotriage_log
      where account_id = $1
        and created_at >= now() - make_interval(days => $2)
      group by coalesce(nullif(sender_email, ''), '(unknown)')
      order by count(*) desc, sender`,
    [accountId, days],
  );
  return r.rows.map((row) => ({
    sender: row.sender,
    count: Number(row.count),
    deleteCount: Number(row.delete_count),
    archiveCount: Number(row.archive_count),
    keepCount: Number(row.keep_count),
    reviewCount: Number(row.review_count),
    subjects: row.subjects ?? [],
    rule: row.rule,
    decider: row.decider as AutoTriageAuditGroup["decider"],
    latestLogId: row.latest_log_id,
    undone: row.undone,
  }));
}
