-- Reverse of 20261017140000_harden_rls_and_retention.sql
-- Restores open seer_bot / seer_app policies. Does not undelete purged events.

drop trigger if exists triage_proposals_bot_cannot_approve on seer.triage_proposals;
drop function if exists seer.triage_proposal_bot_cannot_approve();
drop function if exists seer.purge_old_events(integer);
drop index if exists seer.events_created_at_idx;

create or replace function seer.touch_bot_task_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

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
  if exists (select 1 from pg_roles where rolname = 'seer_bot') then
    foreach table_name in array staff_tables loop
      execute format('drop policy if exists seer_bot_%I on seer.%I', table_name, table_name);
      execute format(
        'create policy seer_bot_%I on seer.%I for all to seer_bot using (true) with check (true)',
        table_name, table_name
      );
    end loop;
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

  if exists (select 1 from pg_roles where rolname = 'seer_app') then
    for table_name in
      select c.relname
        from pg_class c
        join pg_namespace n on n.oid = c.relnamespace
        join pg_policies p on p.schemaname = 'seer' and p.tablename = c.relname
       where n.nspname = 'seer'
         and c.relkind = 'r'
         and p.policyname = 'seer_app_' || c.relname
    loop
      execute format('drop policy if exists seer_app_%I on seer.%I', table_name, table_name);
      execute format(
        'create policy seer_app_%I on seer.%I for all to seer_app using (true) with check (true)',
        table_name, table_name
      );
    end loop;
    execute 'drop policy if exists seer_app_bot_allowed_accounts on seer.bot_allowed_accounts';
  end if;
end $$;

drop function if exists seer.app_can_see_account(uuid);
drop function if exists seer.bot_account_allowed(uuid);
drop table if exists seer.bot_allowed_accounts;
