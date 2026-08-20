-- Push subscriptions + sync waste indexes.
--
-- Outbox sync-mask queries filter on command->>'conversationId' with no index,
-- so every synced conversation seq-scans the whole outbox. Store a generated
-- column and index the active / recent-done slices the mask actually needs.
--
-- mail_push_subscriptions tracks Gmail watches and Graph change notifications
-- so arrival can trigger a single-account wake instead of waiting on the cron.

alter table seer.outbox
  add column if not exists conversation_id uuid
    generated always as ((command->>'conversationId')::uuid) stored;

create index if not exists outbox_account_conversation_active_idx
  on seer.outbox (account_id, conversation_id)
  where status in ('pending', 'inflight')
     or (status = 'failed' and reconcile_needed = true);

create index if not exists outbox_account_conversation_done_idx
  on seer.outbox (account_id, conversation_id, updated_at desc)
  where status = 'done';

create table if not exists seer.mail_push_subscriptions (
  account_id uuid primary key references seer.mail_accounts (id) on delete cascade,
  provider text not null check (provider in ('google', 'microsoft')),
  gmail_history_id text,
  gmail_watch_expires_at timestamptz,
  graph_subscription_id text,
  graph_client_state_hash text,
  graph_expires_at timestamptz,
  last_notification_at timestamptz,
  last_wake_at timestamptz,
  last_error text,
  updated_at timestamptz not null default now()
);

create index if not exists mail_push_graph_subscription_idx
  on seer.mail_push_subscriptions (graph_subscription_id)
  where graph_subscription_id is not null;

create index if not exists mail_push_renewal_idx
  on seer.mail_push_subscriptions (provider, gmail_watch_expires_at, graph_expires_at);

alter table seer.mail_push_subscriptions enable row level security;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'seer_app') then
    grant select, insert, update, delete on seer.mail_push_subscriptions to seer_app;

    execute 'drop policy if exists seer_app_mail_push_subscriptions on seer.mail_push_subscriptions';
    execute $policy$
      create policy seer_app_mail_push_subscriptions on seer.mail_push_subscriptions
        for all to seer_app
        using (true)
        with check (true)
    $policy$;
  end if;
end $$;
