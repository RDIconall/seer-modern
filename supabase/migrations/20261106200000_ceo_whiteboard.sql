-- CEO Whiteboard living beside Atlas.
-- Additive and backwards-compatible: existing bot/mail tables are not rewritten.
-- The external bot writes these tables over SQL. Conall's UI writes them
-- only through v2 commands. Mail still moves solely via seer.outbox.

alter table seer.bot_tasks
  add column if not exists whiteboard_slug text,
  add column if not exists conversation_id uuid references seer.conversations (id) on delete set null;

create index if not exists bot_tasks_whiteboard_slug_idx
  on seer.bot_tasks (account_id, whiteboard_slug)
  where whiteboard_slug is not null;

create index if not exists bot_tasks_conversation_idx
  on seer.bot_tasks (account_id, conversation_id)
  where conversation_id is not null;

create table if not exists seer.whiteboard_sections (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references seer.mail_accounts (id) on delete cascade,
  slug text not null,
  title text not null,
  subtitle text,
  sort_order int not null default 100,
  created_at timestamptz not null default now(),
  unique (account_id, slug)
);

create table if not exists seer.whiteboard_items (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references seer.mail_accounts (id) on delete cascade,
  section_id uuid not null references seer.whiteboard_sections (id) on delete cascade,
  external_key text,
  title text not null,
  body text,
  status text not null default 'open'
    check (status in ('open', 'done', 'dropped')),
  priority int not null default 100,
  due_at timestamptz,
  owner_label text,
  conversation_id uuid references seer.conversations (id) on delete set null,
  matter_id uuid,
  bot_task_id uuid references seer.bot_tasks (id) on delete set null,
  source text not null default 'user'
    check (source in ('user', 'bot')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists whiteboard_items_external_key_idx
  on seer.whiteboard_items (account_id, external_key)
  where external_key is not null;

create index if not exists whiteboard_items_account_section_idx
  on seer.whiteboard_items (account_id, section_id, status, priority, created_at);

create index if not exists whiteboard_items_conversation_idx
  on seer.whiteboard_items (account_id, conversation_id)
  where conversation_id is not null;

create or replace function seer.touch_whiteboard_item_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists whiteboard_items_touch_updated_at on seer.whiteboard_items;
create trigger whiteboard_items_touch_updated_at
  before update on seer.whiteboard_items
  for each row
  execute procedure seer.touch_whiteboard_item_updated_at();

alter table seer.whiteboard_sections enable row level security;
alter table seer.whiteboard_items enable row level security;

do $$
declare
  board_tables text[] := array['whiteboard_sections', 'whiteboard_items'];
  table_name text;
begin
  if exists (select 1 from pg_roles where rolname = 'seer_app') then
    execute 'grant usage on schema seer to seer_app';
    foreach table_name in array board_tables loop
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
    foreach table_name in array board_tables loop
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
  end if;

  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on table seer.whiteboard_sections from anon';
    execute 'revoke all on table seer.whiteboard_items from anon';
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'revoke all on table seer.whiteboard_sections from authenticated';
    execute 'revoke all on table seer.whiteboard_items from authenticated';
  end if;
end $$;
