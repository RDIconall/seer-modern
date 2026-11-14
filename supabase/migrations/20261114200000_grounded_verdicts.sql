-- Grounded per-conversation verdicts, live personal context, and a read-only
-- learning view for the external Seer bot. Additive. Do not apply to production
-- from this PR — preview / local only until Conall approves.

-- ---------------------------------------------------------------------------
-- Decision: who / why / what-to-do, with evidence
-- ---------------------------------------------------------------------------

alter table seer.conversation_decisions
  add column if not exists care text
    check (care is null or care in (
      'needs_you',
      'waiting',
      'record',
      'ignore',
      'review_charge'
    )),
  add column if not exists why text,
  add column if not exists what_to_do text,
  add column if not exists who text,
  add column if not exists harm text,
  add column if not exists importance smallint not null default 0,
  add column if not exists verdict jsonb not null default '{}'::jsonb;

create index if not exists decisions_account_care_idx
  on seer.conversation_decisions (account_id, care)
  where is_current and care is not null;

-- ---------------------------------------------------------------------------
-- About-me profile the AI reads (one document per mailbox)
-- ---------------------------------------------------------------------------

create table if not exists seer.user_profiles (
  account_id uuid primary key references seer.mail_accounts (id) on delete cascade,
  text text not null default '',
  source text not null default 'paste'
    check (source in ('paste', 'google-doc', 'env')),
  source_url text,
  updated_at timestamptz not null default now()
);

alter table seer.user_profiles enable row level security;

-- ---------------------------------------------------------------------------
-- Cached contacts + calendar (Microsoft Graph / Google). Contacts ~6h,
-- events ~5min. Never the system of record for mail.
-- ---------------------------------------------------------------------------

create table if not exists seer.personal_context_cache (
  account_id uuid primary key references seer.mail_accounts (id) on delete cascade,
  contacts text[] not null default '{}',
  auto_contacts text[] not null default '{}',
  events jsonb not null default '[]'::jsonb,
  timezone text,
  people_status text,
  calendar_status text,
  contacts_built_at timestamptz,
  events_built_at timestamptz,
  updated_at timestamptz not null default now()
);

alter table seer.personal_context_cache enable row level security;

-- ---------------------------------------------------------------------------
-- Bot-readable verdicts (SELECT only). Full decision rows stay app-owned.
-- Views run as the owner so seer_bot does not need SELECT on events/outbox.
-- The bot must still filter every query by account_id (same as bot_tasks).
-- ---------------------------------------------------------------------------

create or replace view seer.bot_conversation_verdicts
with (security_invoker = false) as
select
  d.account_id,
  d.conversation_id,
  c.provider_conversation_id,
  c.subject,
  d.home,
  d.owner,
  d.ask,
  d.summary,
  d.priority,
  d.due_date,
  d.care,
  d.why,
  d.what_to_do,
  d.who,
  d.harm,
  d.importance,
  d.verdict,
  d.veto_reasons,
  d.decided_at
from seer.conversation_decisions d
join seer.conversations c
  on c.id = d.conversation_id
 and c.account_id = d.account_id
where d.is_current;

-- Delete / archive / undo / teach signals the inbox bot can learn from.
-- Column-limited: no outbox snapshots, no command receipts, no write path.
create or replace view seer.bot_learning_signals
with (security_invoker = false) as
select
  e.account_id,
  e.id::text as signal_id,
  'event'::text as source,
  e.kind as signal_kind,
  coalesce(e.payload->>'email', e.payload->>'senderEmail') as sender_email,
  e.payload->>'conversationId' as conversation_id,
  e.payload->>'instruction' as instruction,
  e.payload->>'home' as home,
  e.created_at,
  jsonb_strip_nulls(jsonb_build_object(
    'kind', e.kind,
    'email', e.payload->>'email',
    'instruction', e.payload->>'instruction',
    'home', e.payload->>'home',
    'source', e.payload->>'source',
    'conversationId', e.payload->>'conversationId'
  )) as payload
from seer.events e
where e.kind in (
  'user_teach_sender',
  'user_correction',
  'mail_send',
  'mail_reply'
)
union all
select
  o.account_id,
  o.id::text,
  'outbox',
  'outbox_' || coalesce(o.command->>'type', 'unknown'),
  null,
  coalesce(o.command->>'conversationId', o.conversation_id::text),
  case
    when o.status = 'cancelled' then 'undo'
    when coalesce((o.command->>'byUser')::boolean, false) then 'user'
    else o.status
  end,
  o.command->>'type',
  o.updated_at,
  jsonb_strip_nulls(jsonb_build_object(
    'type', o.command->>'type',
    'status', o.status,
    'byUser', o.command->'byUser',
    'conversationId', coalesce(o.command->>'conversationId', o.conversation_id::text)
  ))
from seer.outbox o
where o.command->>'type' in ('archive', 'trash', 'restore')
union all
select
  t.account_id,
  t.id::text,
  'training',
  'training_' || t.kind,
  t.payload->>'email',
  t.conversation_id::text,
  t.kind,
  t.payload->>'home',
  t.created_at,
  jsonb_strip_nulls(jsonb_build_object(
    'kind', t.kind,
    'conversationId', t.conversation_id,
    'outcome', t.payload->>'outcome'
  ))
from seer.training_events t
where t.kind in ('relevance', 'triage');

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'seer_app') then
    execute 'grant select, insert, update, delete on table seer.user_profiles to seer_app';
    execute 'grant select, insert, update, delete on table seer.personal_context_cache to seer_app';
    execute 'grant select on seer.bot_conversation_verdicts to seer_app';
    execute 'grant select on seer.bot_learning_signals to seer_app';
    execute 'drop policy if exists seer_app_user_profiles on seer.user_profiles';
    execute $policy$
      create policy seer_app_user_profiles on seer.user_profiles
        for all to seer_app using (true) with check (true)
    $policy$;
    execute 'drop policy if exists seer_app_personal_context_cache on seer.personal_context_cache';
    execute $policy$
      create policy seer_app_personal_context_cache on seer.personal_context_cache
        for all to seer_app using (true) with check (true)
    $policy$;
  end if;

  if exists (select 1 from pg_roles where rolname = 'seer_bot') then
    execute 'grant select on seer.bot_conversation_verdicts to seer_bot';
    execute 'grant select on seer.bot_learning_signals to seer_bot';
    -- Underlying tables stay unwritable and, except mail corpus, unreadable.
    execute 'revoke insert, update, delete on seer.bot_conversation_verdicts from seer_bot';
    execute 'revoke insert, update, delete on seer.bot_learning_signals from seer_bot';
  end if;

  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on table seer.user_profiles from anon';
    execute 'revoke all on table seer.personal_context_cache from anon';
    execute 'revoke all on seer.bot_conversation_verdicts from anon';
    execute 'revoke all on seer.bot_learning_signals from anon';
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'revoke all on table seer.user_profiles from authenticated';
    execute 'revoke all on table seer.personal_context_cache from authenticated';
    execute 'revoke all on seer.bot_conversation_verdicts from authenticated';
    execute 'revoke all on seer.bot_learning_signals from authenticated';
  end if;
end $$;
