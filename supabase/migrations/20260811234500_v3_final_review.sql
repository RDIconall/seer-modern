-- V3 final-review hardening:
--   * durable folder snapshots across bounded sync ticks
--   * reproducible least-privilege grants and RLS for the complete schema
--   * migration-owned legacy KV table (the app role may use it, Data API roles may not)

alter table seer.folder_sync_state
  add column if not exists scan_generation bigint not null default 0,
  add column if not exists scan_started_at timestamptz,
  add column if not exists last_reconciled_at timestamptz;

create table if not exists seer.folder_sync_seen (
  account_id uuid not null references seer.mail_accounts (id) on delete cascade,
  folder text not null check (folder in ('inbox', 'sent', 'trash')),
  scan_generation bigint not null,
  provider_conversation_id text not null,
  seen_at timestamptz not null default now(),
  primary key (account_id, folder, scan_generation, provider_conversation_id)
);

create index if not exists folder_sync_seen_lookup_idx
  on seer.folder_sync_seen (account_id, folder, scan_generation);

-- The legacy KV facade is still used for non-mail state during the cutover. It
-- is migration-owned so a fresh database has the same least-privilege shape as
-- an existing deployment.
create table if not exists public.seer_kv (
  key text primary key,
  value jsonb not null,
  expires_at timestamptz,
  updated_at timestamptz not null default now()
);

alter table seer.folder_sync_seen enable row level security;
alter table public.seer_kv enable row level security;

do $$
declare
  table_name text;
  policy_name text;
  seer_tables constant text[] := array[
    'users',
    'mail_accounts',
    'oauth_credentials',
    'conversations',
    'messages',
    'people',
    'relationship_evidence',
    'matters',
    'matter_codes',
    'matter_conversations',
    'conversation_decisions',
    'decision_evidence',
    'yields',
    'interest_signals',
    'events',
    'command_receipts',
    'sync_state',
    'sync_runs',
    'model_usage',
    'functions',
    'folder_sync_state',
    'folder_sync_seen',
    'outbox'
  ];
begin
  if not exists (select 1 from pg_roles where rolname = 'seer_app') then
    create role seer_app nologin;
  end if;

  grant usage on schema seer, public to seer_app;
  grant select, insert, update, delete on table public.seer_kv to seer_app;
  grant usage, select, update on all sequences in schema seer to seer_app;
  grant usage, select, update on all sequences in schema public to seer_app;

  -- Explicitly revoke the Data API roles even when a deployment previously
  -- granted broad defaults on public. The role guards keep this migration
  -- runnable on the bare Postgres used by the test harness.
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on schema seer from anon';
    execute 'revoke all on table public.seer_kv from anon';
    foreach table_name in array seer_tables loop
      execute format('revoke all on table seer.%I from anon', table_name);
    end loop;
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'revoke all on schema seer from authenticated';
    execute 'revoke all on table public.seer_kv from authenticated';
    foreach table_name in array seer_tables loop
      execute format('revoke all on table seer.%I from authenticated', table_name);
    end loop;
  end if;

  foreach table_name in array seer_tables loop
    execute format('grant select, insert, update, delete on table seer.%I to seer_app', table_name);
    policy_name := 'seer_app_' || table_name;
    execute format('drop policy if exists %I on seer.%I', policy_name, table_name);
    execute format(
      'create policy %I on seer.%I for all to seer_app using (true) with check (true)',
      policy_name,
      table_name
    );
  end loop;

  execute 'drop policy if exists seer_app_seer_kv on public.seer_kv';
  execute $policy$
    create policy seer_app_seer_kv on public.seer_kv
      for all to seer_app using (true) with check (true)
  $policy$;

  -- Keep future tables/sequences created by the migration owner inside the
  -- same envelope. Runtime code never needs DDL or ownership privileges.
  execute 'alter default privileges in schema seer grant select, insert, update, delete on tables to seer_app';
  execute 'alter default privileges in schema seer grant usage, select, update on sequences to seer_app';
  execute 'alter default privileges in schema public grant select, insert, update, delete on tables to seer_app';
  execute 'alter default privileges in schema public grant usage, select, update on sequences to seer_app';
end $$;
