-- Per-mailbox working style: inferred from the corpus, confirmed by the user,
-- taught from Cards/Triage. focus_hidden lets leave-in-Inbox users clear Focus
-- without moving the provider folder.

alter table seer.conversations
  add column if not exists focus_hidden boolean not null default false;

create index if not exists conversations_focus_idx
  on seer.conversations (account_id, last_message_at desc)
  where is_deleted = false and focus_hidden = false;

create table if not exists seer.mailbox_styles (
  account_id uuid primary key references seer.mail_accounts (id) on delete cascade,
  clear_habit text not null default 'archive'
    check (clear_habit in ('archive', 'delete', 'leave')),
  importance_cues text[] not null default array['none']::text[],
  matter_bar text not null default 'medium'
    check (matter_bar in ('high', 'medium', 'low')),
  confirmed boolean not null default false,
  inferred jsonb not null default '{}'::jsonb,
  drift_prompt text,
  confirmed_at timestamptz,
  updated_at timestamptz not null default now()
);

create table if not exists seer.training_events (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references seer.mail_accounts (id) on delete cascade,
  conversation_id uuid references seer.conversations (id) on delete set null,
  kind text not null
    check (kind in ('confirm_style', 'relevance', 'triage', 'dismiss_drift')),
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists training_events_account_idx
  on seer.training_events (account_id, created_at desc);

alter table seer.mailbox_styles enable row level security;
alter table seer.training_events enable row level security;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'seer_app') then
    grant select, insert, update, delete on seer.mailbox_styles to seer_app;
    grant select, insert, update, delete on seer.training_events to seer_app;

    execute 'drop policy if exists seer_app_mailbox_styles on seer.mailbox_styles';
    execute $policy$
      create policy seer_app_mailbox_styles on seer.mailbox_styles
        for all to seer_app
        using (true)
        with check (true)
    $policy$;

    execute 'drop policy if exists seer_app_training_events on seer.training_events';
    execute $policy$
      create policy seer_app_training_events on seer.training_events
        for all to seer_app
        using (true)
        with check (true)
    $policy$;
  end if;
end $$;
