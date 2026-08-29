-- Per-mailbox Atlas operating model: user guidance and the last AI proposal.
-- Live shelves remain seer.functions; this row is the desk's instructions and
-- the draft the user can edit before applying.

create table if not exists seer.operating_models (
  account_id uuid primary key references seer.mail_accounts (id) on delete cascade,
  guidance text not null default '',
  proposal jsonb,
  proposed_at timestamptz,
  accepted_at timestamptz,
  updated_at timestamptz not null default now()
);

alter table seer.operating_models enable row level security;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'seer_app') then
    grant select, insert, update, delete on seer.operating_models to seer_app;

    execute 'drop policy if exists seer_app_operating_models on seer.operating_models';
    execute $policy$
      create policy seer_app_operating_models on seer.operating_models
        for all to seer_app
        using (true)
        with check (true)
    $policy$;
  end if;
end $$;
