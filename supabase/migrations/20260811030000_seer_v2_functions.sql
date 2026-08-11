-- ---------------------------------------------------------------------------
-- Functions: the sections of the user's whiteboard.
--
-- A matter already records WHO it is with (org_unit, the counterparty). That is
-- the wrong axis for the board: "Roche stability fixes", "Roche MyBuy" and
-- "Roche procurement" are software, sales and business development — three
-- different parts of the business that happen to share a counterparty. The
-- whiteboard is organised by the part of the business, so a matter needs that
-- too.
--
-- The registry is the user's own org chart, never an AI-invented taxonomy: a
-- matter may only be filed under a function that exists here.
-- ---------------------------------------------------------------------------

create table if not exists seer.functions (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references seer.mail_accounts (id) on delete cascade,
  name text not null,
  -- Two axes, because the previous system had two and needed both:
  --   'function' — a part of the business, where WORK belongs ("recruiting").
  --   'topic'    — what a piece of mail IS, for the disposable end that is not
  --               anyone's work ("Newsletters & vendor mail").
  -- Without topics, notifications get forced into a function and a newsletter
  -- ends up filed under "systems (it)" as though it were engineering work.
  kind text not null default 'function' check (kind in ('function', 'topic')),
  -- Registry order drives the order of sections and board columns.
  position int not null default 0,
  created_at timestamptz not null default now(),
  unique (account_id, name)
);

create index if not exists functions_account_kind_idx
  on seer.functions (account_id, kind, position);

create index if not exists functions_account_position_idx
  on seer.functions (account_id, position);

alter table seer.functions enable row level security;

-- The function a matter is filed under, plus how it got there. A user's own
-- filing must never be overwritten by a later automatic pass.
alter table seer.matters
  add column if not exists function_name text,
  add column if not exists function_source text not null default 'inferred'
    check (function_source in ('inferred', 'user'));

create index if not exists matters_account_function_idx
  on seer.matters (account_id, function_name);

-- Triage groups by function too. A conversation that never became a matter
-- still belongs to a part of the business — the previous system filed every
-- email this way, and grouping triage by the sender's company instead scatters
-- one function's work across a dozen headings.
alter table seer.conversations
  add column if not exists function_name text,
  add column if not exists function_source text not null default 'inferred'
    check (function_source in ('inferred', 'user'));

create index if not exists conversations_account_function_idx
  on seer.conversations (account_id, function_name);
