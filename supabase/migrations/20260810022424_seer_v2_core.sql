-- Seer v2 core schema.
--
-- The durable system of record. All business rows live in the private `seer`
-- schema (never the API-exposed `public`), are scoped to one mail account, and
-- carry timestamps. This single file is the source of truth: it is applied to
-- Supabase at deploy time and to a local Postgres in tests. Statements that
-- depend on Supabase-only roles (`anon`, `authenticated`) are guarded so the
-- same migration runs unchanged on a bare Postgres.

create schema if not exists seer;

-- Lock the schema down where the Data-API roles exist; no-op elsewhere.
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on schema seer from anon';
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'revoke all on schema seer from authenticated';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Identity and access
-- ---------------------------------------------------------------------------

create table if not exists seer.users (
  id uuid primary key default gen_random_uuid(),
  email text not null unique,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists seer.mail_accounts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references seer.users (id) on delete cascade,
  provider text not null check (provider in ('google', 'microsoft')),
  email text not null,
  display_name text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (provider, email)
);

create table if not exists seer.oauth_credentials (
  account_id uuid primary key references seer.mail_accounts (id) on delete cascade,
  provider text not null,
  ciphertext jsonb not null,
  expires_at timestamptz,
  version integer not null default 1,
  rotated_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Mailbox corpus
-- ---------------------------------------------------------------------------

create table if not exists seer.conversations (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references seer.mail_accounts (id) on delete cascade,
  provider_conversation_id text not null,
  subject text,
  last_message_at timestamptz,
  message_count integer not null default 0,
  is_deleted boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (account_id, provider_conversation_id)
);

create table if not exists seer.messages (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references seer.mail_accounts (id) on delete cascade,
  conversation_id uuid not null references seer.conversations (id) on delete cascade,
  provider_message_id text not null,
  from_email text,
  from_name text,
  to_emails text[] not null default '{}',
  cc_emails text[] not null default '{}',
  sent_at timestamptz,
  snippet text,
  body_html text,
  body_text text,
  is_unread boolean not null default false,
  is_outgoing boolean not null default false,
  created_at timestamptz not null default now(),
  unique (account_id, provider_message_id)
);

-- ---------------------------------------------------------------------------
-- People and relationship evidence
-- ---------------------------------------------------------------------------

create table if not exists seer.people (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references seer.mail_accounts (id) on delete cascade,
  email text not null,
  display_name text,
  tier text not null default 'unknown'
    check (tier in ('inner', 'known', 'new-credible', 'machine', 'unknown')),
  vip boolean not null default false,
  vip_source text check (vip_source in ('user', 'inferred')),
  updated_at timestamptz not null default now(),
  unique (account_id, email)
);

create table if not exists seer.relationship_evidence (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references seer.mail_accounts (id) on delete cascade,
  person_email text not null,
  kind text not null,
  weight double precision not null default 0,
  observed_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Matters
-- ---------------------------------------------------------------------------

create table if not exists seer.matters (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references seer.mail_accounts (id) on delete cascade,
  title text not null,
  status text not null default 'open'
    check (status in ('open', 'looks-closed', 'closed')),
  org_unit text,
  goal text,
  narrative text,
  title_source text not null default 'inferred'
    check (title_source in ('inferred', 'user')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Codes a matter is known by (study/event/document ids). These are the most
-- reliable signal that two conversations are the same unit of work.
create table if not exists seer.matter_codes (
  matter_id uuid not null references seer.matters (id) on delete cascade,
  code text not null,
  primary key (matter_id, code)
);

create table if not exists seer.matter_conversations (
  matter_id uuid not null references seer.matters (id) on delete cascade,
  conversation_id uuid not null references seer.conversations (id) on delete cascade,
  link_source text not null default 'inferred'
    check (link_source in ('inferred', 'user')),
  linked_at timestamptz not null default now(),
  primary key (matter_id, conversation_id)
);

-- ---------------------------------------------------------------------------
-- Decisions (the single home authority) and their evidence
-- ---------------------------------------------------------------------------

create table if not exists seer.conversation_decisions (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references seer.mail_accounts (id) on delete cascade,
  conversation_id uuid not null references seer.conversations (id) on delete cascade,
  home text not null check (home in ('matter', 'record', 'delete', 'undecided')),
  proposed_home text not null
    check (proposed_home in ('matter', 'record', 'delete', 'undecided')),
  summary text not null default '',
  rationale text not null default '',
  owner text not null default 'nobody'
    check (owner in ('you', 'team', 'them', 'nobody')),
  ask text,
  matter_id uuid references seer.matters (id) on delete set null,
  veto_reasons text[] not null default '{}',
  -- 0 (ambient) … 3 (direct demand from someone senior). Computed from facts.
  priority smallint not null default 0,
  model_version text not null,
  context_version text not null,
  is_current boolean not null default true,
  decided_at timestamptz not null default now(),
  unique (conversation_id, model_version, context_version, decided_at)
);

create unique index if not exists conversation_decisions_current_idx
  on seer.conversation_decisions (conversation_id)
  where is_current;

create table if not exists seer.decision_evidence (
  id uuid primary key default gen_random_uuid(),
  decision_id uuid not null references seer.conversation_decisions (id) on delete cascade,
  ref text not null,
  provenance text not null
    check (provenance in ('explicit', 'system', 'calendar', 'observed', 'inference')),
  detail text
);

-- ---------------------------------------------------------------------------
-- Extracted meaning (yields) and interest signals
-- ---------------------------------------------------------------------------

create table if not exists seer.yields (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references seer.mail_accounts (id) on delete cascade,
  decision_id uuid not null references seer.conversation_decisions (id) on delete cascade,
  conversation_id uuid not null references seer.conversations (id) on delete cascade,
  kind text not null
    check (kind in ('matter_connection', 'worth_reading', 'contact', 'fact')),
  matter_id uuid references seer.matters (id) on delete set null,
  headline text not null,
  detail text,
  evidence_ref text,
  created_at timestamptz not null default now()
);

create table if not exists seer.interest_signals (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references seer.mail_accounts (id) on delete cascade,
  topic text not null,
  source text not null check (source in ('explicit', 'observed')),
  weight double precision not null default 0,
  observed_at timestamptz not null default now(),
  unique (account_id, topic, source)
);

-- ---------------------------------------------------------------------------
-- Append-only audit and idempotency
-- ---------------------------------------------------------------------------

create table if not exists seer.events (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references seer.mail_accounts (id) on delete cascade,
  kind text not null,
  idempotency_key text,
  payload jsonb not null default '{}',
  created_at timestamptz not null default now(),
  unique (account_id, idempotency_key)
);

create table if not exists seer.command_receipts (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references seer.mail_accounts (id) on delete cascade,
  idempotency_key text not null,
  command_type text not null,
  result jsonb not null default '{}',
  created_at timestamptz not null default now(),
  unique (account_id, idempotency_key)
);

-- ---------------------------------------------------------------------------
-- Sync bookkeeping
-- ---------------------------------------------------------------------------

create table if not exists seer.sync_state (
  account_id uuid primary key references seer.mail_accounts (id) on delete cascade,
  cursor text,
  provider_total integer not null default 0,
  updated_at timestamptz not null default now()
);

create table if not exists seer.sync_runs (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references seer.mail_accounts (id) on delete cascade,
  trace_id text not null,
  mode text not null,
  provider_total integer not null default 0,
  stored integer not null default 0,
  pending integer not null default 0,
  failed integer not null default 0,
  started_at timestamptz not null default now(),
  finished_at timestamptz
);

-- ---------------------------------------------------------------------------
-- Row-level security: on for every account-scoped table. The server connects
-- as the table owner / service role (which bypasses RLS); the Data-API roles
-- get no policy and therefore no access.
-- ---------------------------------------------------------------------------

alter table seer.users enable row level security;
alter table seer.mail_accounts enable row level security;
alter table seer.oauth_credentials enable row level security;
alter table seer.conversations enable row level security;
alter table seer.messages enable row level security;
alter table seer.people enable row level security;
alter table seer.relationship_evidence enable row level security;
alter table seer.matters enable row level security;
alter table seer.matter_codes enable row level security;
alter table seer.matter_conversations enable row level security;
alter table seer.conversation_decisions enable row level security;
alter table seer.decision_evidence enable row level security;
alter table seer.yields enable row level security;
alter table seer.interest_signals enable row level security;
alter table seer.events enable row level security;
alter table seer.command_receipts enable row level security;
alter table seer.sync_state enable row level security;
alter table seer.sync_runs enable row level security;

-- ---------------------------------------------------------------------------
-- Indexes for the read paths the app actually runs.
-- ---------------------------------------------------------------------------

create index if not exists conversations_account_recent_idx
  on seer.conversations (account_id, last_message_at desc);
create index if not exists messages_conversation_idx
  on seer.messages (conversation_id, sent_at);
create index if not exists decisions_account_home_idx
  on seer.conversation_decisions (account_id, home) where is_current;
create index if not exists people_account_email_idx
  on seer.people (account_id, email);
create index if not exists matters_account_status_idx
  on seer.matters (account_id, status);
create index if not exists yields_account_kind_idx
  on seer.yields (account_id, kind);
