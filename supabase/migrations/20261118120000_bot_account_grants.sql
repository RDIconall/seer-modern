-- Scope the seer_bot role to mailboxes an operator has explicitly granted.
--
-- Every seer_bot policy on an account-scoped table allows a row only when its
-- account is listed in seer.bot_account_grants. seer_bot can read that list
-- but never write it, so a bot login cannot widen its own reach. Message
-- bodies, snippets, participants, and attachment names are not readable by
-- seer_bot at all: attaching a proposal needs conversation ids and subjects.

create table if not exists seer.bot_account_grants (
  account_id uuid primary key references seer.mail_accounts (id) on delete cascade,
  created_at timestamptz not null default now()
);

alter table seer.bot_account_grants enable row level security;

revoke all on table seer.bot_account_grants from public;

do $$
declare
  staff_tables text[] := array[
    'bot_tasks',
    'bot_task_events',
    'bot_messages',
    'triage_proposals'
  ];
  corpus_tables text[] := array[
    'conversations',
    'matters'
  ];
  table_name text;
begin
  if exists (select 1 from pg_roles where rolname = 'seer_app') then
    execute 'revoke all on table seer.bot_account_grants from seer_app';
  end if;
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on table seer.bot_account_grants from anon';
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'revoke all on table seer.bot_account_grants from authenticated';
  end if;

  if not exists (select 1 from pg_roles where rolname = 'seer_bot') then
    return;
  end if;

  execute 'revoke all on table seer.bot_account_grants from seer_bot';
  execute 'grant select on table seer.bot_account_grants to seer_bot';
  execute 'drop policy if exists seer_bot_bot_account_grants_select on seer.bot_account_grants';
  execute $policy$
    create policy seer_bot_bot_account_grants_select on seer.bot_account_grants
      for select to seer_bot using (true)
  $policy$;

  foreach table_name in array staff_tables loop
    execute format('drop policy if exists seer_bot_%I on seer.%I', table_name, table_name);
    execute format(
      $policy$
        create policy seer_bot_%I on seer.%I for all to seer_bot
          using (account_id in (select g.account_id from seer.bot_account_grants g))
          with check (account_id in (select g.account_id from seer.bot_account_grants g))
      $policy$,
      table_name,
      table_name
    );
  end loop;

  execute 'drop policy if exists seer_bot_mail_accounts_select on seer.mail_accounts';
  execute $policy$
    create policy seer_bot_mail_accounts_select on seer.mail_accounts
      for select to seer_bot
      using (id in (select g.account_id from seer.bot_account_grants g))
  $policy$;

  foreach table_name in array corpus_tables loop
    execute format('drop policy if exists seer_bot_%I_select on seer.%I', table_name, table_name);
    execute format(
      $policy$
        create policy seer_bot_%I_select on seer.%I for select to seer_bot
          using (account_id in (select g.account_id from seer.bot_account_grants g))
      $policy$,
      table_name,
      table_name
    );
  end loop;

  execute 'revoke all on table seer.messages from seer_bot';
  execute $grant$
    grant select (id, account_id, conversation_id, provider_message_id, sent_at)
      on table seer.messages to seer_bot
  $grant$;
  execute 'drop policy if exists seer_bot_messages_select on seer.messages';
  execute $policy$
    create policy seer_bot_messages_select on seer.messages
      for select to seer_bot
      using (account_id in (select g.account_id from seer.bot_account_grants g))
  $policy$;
end $$;
