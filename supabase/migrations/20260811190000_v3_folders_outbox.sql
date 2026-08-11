-- V3 folder-aware corpus columns, per-folder sync cursors, and mutation outbox.

alter table seer.conversations
  add column if not exists folders text[] not null default '{}',
  add column if not exists is_unread boolean not null default false,
  add column if not exists last_synced_at timestamptz;

create table if not exists seer.folder_sync_state (
  account_id uuid not null references seer.mail_accounts (id) on delete cascade,
  folder text not null check (folder in ('inbox', 'sent', 'trash')),
  cursor text,
  provider_total int not null default 0,
  updated_at timestamptz not null default now(),
  primary key (account_id, folder)
);

create table if not exists seer.outbox (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references seer.mail_accounts (id) on delete cascade,
  command jsonb not null,
  idempotency_key text not null,
  status text not null default 'pending'
    check (status in ('pending', 'inflight', 'done', 'failed', 'cancelled')),
  attempts int not null default 0,
  last_error text,
  next_attempt_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (account_id, idempotency_key)
);

-- Read paths: account-scoped mailbox lists plus folder containment (@>).
-- PostgreSQL cannot combine uuid btree and text[] GIN in one index without an
-- extension, so both axes are indexed explicitly.
drop index if exists seer.conversations_account_folders_idx;

create index if not exists conversations_account_folders_account_idx
  on seer.conversations (account_id);

create index if not exists conversations_account_folders_gin_idx
  on seer.conversations using gin (folders);

create index if not exists outbox_account_pending_idx
  on seer.outbox (account_id, next_attempt_at)
  where status = 'pending';

alter table seer.folder_sync_state enable row level security;
alter table seer.outbox enable row level security;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'seer_app') then
    grant select, insert, update, delete on seer.folder_sync_state to seer_app;
    grant select, insert, update, delete on seer.outbox to seer_app;
    grant usage, select on all sequences in schema seer to seer_app;

    execute 'drop policy if exists seer_app_folder_sync_state on seer.folder_sync_state';
    execute $policy$
      create policy seer_app_folder_sync_state on seer.folder_sync_state
        for all to seer_app using (true) with check (true)
    $policy$;

    execute 'drop policy if exists seer_app_outbox on seer.outbox';
    execute $policy$
      create policy seer_app_outbox on seer.outbox
        for all to seer_app using (true) with check (true)
    $policy$;
  end if;
end $$;
