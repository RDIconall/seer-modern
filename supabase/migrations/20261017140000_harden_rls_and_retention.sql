-- Harden seer_bot RLS, optional per-account seer_app RLS, and events retention.
-- Reversible: see the down script at the bottom of this file (commented) and
-- supabase/migrations/down/20261017140000_harden_rls_and_retention.sql.

-- ---------------------------------------------------------------------------
-- Bot allowlist: seer_bot may only touch these mailboxes.
-- Seed Conall's account when that row exists; no-op otherwise.
-- ---------------------------------------------------------------------------

create table if not exists seer.bot_allowed_accounts (
  account_id uuid primary key references seer.mail_accounts (id) on delete cascade,
  created_at timestamptz not null default now()
);

alter table seer.bot_allowed_accounts enable row level security;

insert into seer.bot_allowed_accounts (account_id)
select id
  from seer.mail_accounts
 where id = '70122bd2-0c14-49db-b2c7-48111828fb68'
on conflict (account_id) do nothing;

create or replace function seer.bot_account_allowed(target uuid)
returns boolean
language sql
stable
security definer
set search_path = seer, pg_temp
as $$
  select exists (
    select 1 from seer.bot_allowed_accounts where account_id = target
  );
$$;

revoke all on function seer.bot_account_allowed(uuid) from public;
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'seer_bot') then
    execute 'grant execute on function seer.bot_account_allowed(uuid) to seer_bot';
  end if;
  if exists (select 1 from pg_roles where rolname = 'seer_app') then
    execute 'grant execute on function seer.bot_account_allowed(uuid) to seer_app';
  end if;
end $$;

-- Dual-mode tenant helper for seer_app. Unset seer.account_id keeps today's
-- open policy (cron and pooled queries keep working). SET LOCAL seer.account_id
-- inside a transaction scopes that connection to one mailbox.
create or replace function seer.app_can_see_account(target uuid)
returns boolean
language sql
stable
parallel safe
set search_path = seer, pg_temp
as $$
  select coalesce(nullif(current_setting('seer.account_id', true), ''), '') = ''
      or current_setting('seer.account_id', true) = target::text;
$$;

revoke all on function seer.app_can_see_account(uuid) from public;
grant execute on function seer.app_can_see_account(uuid) to seer_app;

-- Fix mutable search_path on the staff trigger (Supabase advisor warning).
create or replace function seer.touch_bot_task_updated_at()
returns trigger
language plpgsql
set search_path = seer, pg_temp
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- Events older than 90 days only. Never deletes corpus or staff rows.
create or replace function seer.purge_old_events(retention_days integer default 90)
returns integer
language plpgsql
security definer
set search_path = seer, pg_temp
as $$
declare
  deleted integer;
begin
  if retention_days is null or retention_days < 90 then
    raise exception 'retention_days must be >= 90';
  end if;
  delete from seer.events
   where created_at < now() - make_interval(days => retention_days);
  get diagnostics deleted = row_count;
  return deleted;
end;
$$;

revoke all on function seer.purge_old_events(integer) from public;
grant execute on function seer.purge_old_events(integer) to seer_app;

create index if not exists events_created_at_idx on seer.events (created_at);

do $$
declare
  staff_tables text[] := array[
    'bot_tasks',
    'bot_task_events',
    'bot_messages',
    'triage_proposals'
  ];
  table_name text;
  col text;
begin
  if exists (select 1 from pg_roles where rolname = 'seer_app') then
    execute 'grant select, insert, update, delete on table seer.bot_allowed_accounts to seer_app';
    execute 'drop policy if exists seer_app_bot_allowed_accounts on seer.bot_allowed_accounts';
    execute $policy$
      create policy seer_app_bot_allowed_accounts on seer.bot_allowed_accounts
        for all to seer_app using (true) with check (true)
    $policy$;
  end if;

  if exists (select 1 from pg_roles where rolname = 'seer_bot') then
    -- Catalog stays readable/writable; staff rows are account-scoped.
    execute 'drop policy if exists seer_bot_bots on seer.bots';
    execute $policy$
      create policy seer_bot_bots on seer.bots
        for all to seer_bot using (true) with check (true)
    $policy$;

    foreach table_name in array staff_tables loop
      execute format('drop policy if exists seer_bot_%I on seer.%I', table_name, table_name);
      if table_name = 'triage_proposals' then
        execute $policy$
          create policy seer_bot_triage_proposals on seer.triage_proposals
            for all to seer_bot
            using (seer.bot_account_allowed(account_id))
            with check (
              seer.bot_account_allowed(account_id)
              and status not in ('approved', 'executed')
            )
        $policy$;
      else
        execute format(
          'create policy seer_bot_%I on seer.%I for all to seer_bot
             using (seer.bot_account_allowed(account_id))
             with check (seer.bot_account_allowed(account_id))',
          table_name,
          table_name
        );
      end if;
    end loop;

    execute 'drop policy if exists seer_bot_mail_accounts_select on seer.mail_accounts';
    execute $policy$
      create policy seer_bot_mail_accounts_select on seer.mail_accounts
        for select to seer_bot
        using (seer.bot_account_allowed(id))
    $policy$;

    execute 'drop policy if exists seer_bot_conversations_select on seer.conversations';
    execute $policy$
      create policy seer_bot_conversations_select on seer.conversations
        for select to seer_bot
        using (seer.bot_account_allowed(account_id))
    $policy$;

    -- Message bodies and matters are not required to attach a proposal.
    execute 'drop policy if exists seer_bot_messages_select on seer.messages';
    execute 'drop policy if exists seer_bot_matters_select on seer.matters';
    execute 'revoke select on table seer.messages from seer_bot';
    execute 'revoke select on table seer.matters from seer_bot';
  end if;

  -- seer_app: dual-mode account scope on tables that have an account id.
  -- Unset GUC => open (current behaviour). SET LOCAL seer.account_id => one desk.
  if exists (select 1 from pg_roles where rolname = 'seer_app') then
    for table_name, col in
      select c.relname,
             case
               when exists (
                 select 1 from pg_attribute a
                  where a.attrelid = c.oid
                    and a.attname = 'account_id'
                    and a.attnum > 0
                    and not a.attisdropped
               ) then 'account_id'
               when c.relname = 'mail_accounts' then 'id'
               else null
             end
        from pg_class c
        join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'seer'
         and c.relkind = 'r'
    loop
      if col is null then
        continue;
      end if;
      if not exists (
        select 1 from pg_policies
         where schemaname = 'seer'
           and tablename = table_name
           and policyname = 'seer_app_' || table_name
      ) then
        continue;
      end if;
      execute format('drop policy if exists seer_app_%I on seer.%I', table_name, table_name);
      execute format(
        'create policy seer_app_%I on seer.%I for all to seer_app
           using (seer.app_can_see_account(%I))
           with check (seer.app_can_see_account(%I))',
        table_name, table_name, col, col
      );
    end loop;
  end if;

  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on table seer.bot_allowed_accounts from anon';
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'revoke all on table seer.bot_allowed_accounts from authenticated';
  end if;
end $$;
