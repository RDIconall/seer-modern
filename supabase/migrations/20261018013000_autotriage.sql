-- Automatic inbox triage: settings, watermark, decision log, sender rules.
-- Reversible: supabase/migrations/down/20261018013000_autotriage.sql
-- Auto-triage runs as seer_app (the server). seer_bot may SELECT, never write.

create table if not exists seer.autotriage_settings (
  account_id uuid primary key references seer.mail_accounts (id) on delete cascade,
  mode text not null default 'dry_run' check (mode in ('off', 'dry_run', 'live')),
  ai_enabled boolean not null default false,
  ai_auto_threshold numeric not null default 0.9,
  updated_at timestamptz not null default now()
);

create table if not exists seer.autotriage_state (
  account_id uuid primary key references seer.mail_accounts (id) on delete cascade,
  last_message_at timestamptz,
  updated_at timestamptz not null default now()
);

create table if not exists seer.autotriage_log (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references seer.mail_accounts (id) on delete cascade,
  conversation_id uuid references seer.conversations (id) on delete set null,
  provider_message_id text not null,
  sender_email text,
  subject text,
  action text not null check (action in ('delete', 'archive', 'keep', 'review', 'save-doc', 'unknown')),
  proposed text,
  rule text,
  reason text,
  decider text not null check (decider in ('rule', 'ai', 'user')),
  ai_confidence numeric,
  mode text not null,
  outbox_id uuid,
  proposal_id uuid,
  undone_at timestamptz,
  undo_outbox_id uuid,
  created_at timestamptz not null default now(),
  unique (account_id, provider_message_id)
);

create index if not exists autotriage_log_account_created_idx
  on seer.autotriage_log (account_id, created_at desc);

create table if not exists seer.triage_sender_rules (
  account_id uuid not null references seer.mail_accounts (id) on delete cascade,
  sender text not null,
  kind text not null check (kind in ('always_keep', 'delete', 'archive')),
  source text not null default 'user',
  created_at timestamptz not null default now(),
  primary key (account_id, sender)
);

alter table seer.autotriage_settings enable row level security;
alter table seer.autotriage_state enable row level security;
alter table seer.autotriage_log enable row level security;
alter table seer.triage_sender_rules enable row level security;

do $$
declare
  table_name text;
  tables text[] := array[
    'autotriage_settings',
    'autotriage_state',
    'autotriage_log',
    'triage_sender_rules'
  ];
begin
  if exists (select 1 from pg_roles where rolname = 'seer_app') then
    foreach table_name in array tables loop
      execute format(
        'grant select, insert, update, delete on table seer.%I to seer_app',
        table_name
      );
      execute format('drop policy if exists seer_app_%I on seer.%I', table_name, table_name);
      execute format(
        'create policy seer_app_%I on seer.%I for all to seer_app
           using (seer.app_can_see_account(account_id))
           with check (seer.app_can_see_account(account_id))',
        table_name, table_name
      );
    end loop;
  end if;

  if exists (select 1 from pg_roles where rolname = 'seer_bot') then
    foreach table_name in array tables loop
      execute format('grant select on table seer.%I to seer_bot', table_name);
      execute format('drop policy if exists seer_bot_%I on seer.%I', table_name, table_name);
      execute format(
        'create policy seer_bot_%I on seer.%I for select to seer_bot
           using (seer.bot_account_allowed(account_id))',
        table_name, table_name
      );
    end loop;
  end if;

  if exists (select 1 from pg_roles where rolname = 'anon') then
    foreach table_name in array tables loop
      execute format('revoke all on table seer.%I from anon', table_name);
    end loop;
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    foreach table_name in array tables loop
      execute format('revoke all on table seer.%I from authenticated', table_name);
    end loop;
  end if;
end $$;
