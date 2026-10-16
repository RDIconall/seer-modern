-- Chief of staff / delegated work living beside Atlas.
-- The external bot writes these tables over SQL. Conall's UI writes them
-- only through v2 commands. Mail still moves solely via seer.outbox.

create table if not exists seer.bots (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique,
  display_name text not null,
  created_at timestamptz not null default now()
);

create table if not exists seer.bot_tasks (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references seer.mail_accounts (id) on delete cascade,
  bot_id uuid not null references seer.bots (id),
  external_key text,
  title text not null,
  status text not null default 'open'
    check (status in (
      'open',
      'in_progress',
      'blocked',
      'waiting_on_user',
      'done',
      'dropped'
    )),
  priority int not null default 100,
  due_at timestamptz,
  notes text,
  his_words text,
  current_state text,
  next_action text,
  source text not null default 'bot'
    check (source in ('user', 'bot')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists bot_tasks_external_key_idx
  on seer.bot_tasks (account_id, external_key)
  where external_key is not null;

create index if not exists bot_tasks_account_status_idx
  on seer.bot_tasks (account_id, status, priority, created_at);

create table if not exists seer.bot_task_events (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references seer.mail_accounts (id) on delete cascade,
  task_id uuid not null references seer.bot_tasks (id) on delete cascade,
  actor text not null check (actor in ('user', 'bot')),
  actor_name text not null,
  kind text not null check (kind in (
    'created',
    'status',
    'comment',
    'note',
    'priority',
    'due',
    'assign',
    'title'
  )),
  body text,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists bot_task_events_task_idx
  on seer.bot_task_events (task_id, created_at);

create index if not exists bot_task_events_account_idx
  on seer.bot_task_events (account_id, created_at);

create table if not exists seer.bot_messages (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references seer.mail_accounts (id) on delete cascade,
  bot_id uuid not null references seer.bots (id),
  task_id uuid references seer.bot_tasks (id) on delete cascade,
  author text not null check (author in ('user', 'bot')),
  body text not null,
  created_at timestamptz not null default now()
);

create index if not exists bot_messages_thread_idx
  on seer.bot_messages (account_id, bot_id, task_id, created_at);

create table if not exists seer.triage_proposals (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references seer.mail_accounts (id) on delete cascade,
  bot_id uuid not null references seer.bots (id),
  conversation_id uuid references seer.conversations (id) on delete set null,
  provider_conversation_id text,
  sender_email text,
  subject text,
  action text not null check (action in (
    'delete',
    'archive',
    'keep',
    'file',
    'filtered'
  )),
  destination_id text,
  destination_name text,
  rationale text,
  status text not null default 'pending'
    check (status in (
      'pending',
      'approved',
      'rejected',
      'executed',
      'failed'
    )),
  last_error text,
  outbox_id uuid,
  created_at timestamptz not null default now(),
  decided_at timestamptz,
  decided_by text check (decided_by in ('user', 'bot'))
);

create index if not exists triage_proposals_account_status_idx
  on seer.triage_proposals (account_id, status, created_at);

create or replace function seer.touch_bot_task_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists bot_tasks_touch_updated_at on seer.bot_tasks;
create trigger bot_tasks_touch_updated_at
  before update on seer.bot_tasks
  for each row
  execute procedure seer.touch_bot_task_updated_at();

insert into seer.bots (slug, display_name) values
  ('chief-of-staff', 'Chief of staff'),
  ('personal-chief-of-staff', 'Personal Chief of Staff'),
  ('snak-bot', 'SnaK-Bot'),
  ('it-admin', 'IT Admin'),
  ('site-outreach', 'Site Outreach'),
  ('recruiter', 'Recruiter'),
  ('growth', 'Growth'),
  ('proposals-bids', 'Proposals & Bids')
on conflict (slug) do nothing;

alter table seer.bots enable row level security;
alter table seer.bot_tasks enable row level security;
alter table seer.bot_task_events enable row level security;
alter table seer.bot_messages enable row level security;
alter table seer.triage_proposals enable row level security;

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'seer_bot') then
    create role seer_bot nologin noinherit;
  end if;
end $$;

do $$
declare
  staff_tables text[] := array[
    'bots',
    'bot_tasks',
    'bot_task_events',
    'bot_messages',
    'triage_proposals'
  ];
  table_name text;
begin
  if exists (select 1 from pg_roles where rolname = 'seer_app') then
    execute 'grant usage on schema seer to seer_app';
    foreach table_name in array staff_tables loop
      execute format(
        'grant select, insert, update, delete on table seer.%I to seer_app',
        table_name
      );
      execute format('drop policy if exists seer_app_%I on seer.%I', table_name, table_name);
      execute format(
        'create policy seer_app_%I on seer.%I for all to seer_app using (true) with check (true)',
        table_name,
        table_name
      );
    end loop;
  end if;

  if exists (select 1 from pg_roles where rolname = 'seer_bot') then
    execute 'grant usage on schema seer to seer_bot';
    foreach table_name in array staff_tables loop
      execute format(
        'grant select, insert, update, delete on table seer.%I to seer_bot',
        table_name
      );
      execute format('drop policy if exists seer_bot_%I on seer.%I', table_name, table_name);
      execute format(
        'create policy seer_bot_%I on seer.%I for all to seer_bot using (true) with check (true)',
        table_name,
        table_name
      );
    end loop;
    -- Lookups so the bot can attach proposals to corpus conversations.
    execute 'grant select on table seer.mail_accounts to seer_bot';
    execute 'grant select on table seer.conversations to seer_bot';
    execute 'grant select on table seer.messages to seer_bot';
    execute 'grant select on table seer.matters to seer_bot';
    execute 'drop policy if exists seer_bot_mail_accounts_select on seer.mail_accounts';
    execute $policy$
      create policy seer_bot_mail_accounts_select on seer.mail_accounts
        for select to seer_bot using (true)
    $policy$;
    execute 'drop policy if exists seer_bot_conversations_select on seer.conversations';
    execute $policy$
      create policy seer_bot_conversations_select on seer.conversations
        for select to seer_bot using (true)
    $policy$;
    execute 'drop policy if exists seer_bot_messages_select on seer.messages';
    execute $policy$
      create policy seer_bot_messages_select on seer.messages
        for select to seer_bot using (true)
    $policy$;
    execute 'drop policy if exists seer_bot_matters_select on seer.matters';
    execute $policy$
      create policy seer_bot_matters_select on seer.matters
        for select to seer_bot using (true)
    $policy$;
  end if;

  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on table seer.bots from anon';
    execute 'revoke all on table seer.bot_tasks from anon';
    execute 'revoke all on table seer.bot_task_events from anon';
    execute 'revoke all on table seer.bot_messages from anon';
    execute 'revoke all on table seer.triage_proposals from anon';
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'revoke all on table seer.bots from authenticated';
    execute 'revoke all on table seer.bot_tasks from authenticated';
    execute 'revoke all on table seer.bot_task_events from authenticated';
    execute 'revoke all on table seer.bot_messages from authenticated';
    execute 'revoke all on table seer.triage_proposals from authenticated';
  end if;
end $$;
