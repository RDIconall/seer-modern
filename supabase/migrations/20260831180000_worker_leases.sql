-- One read worker and one sync worker per mailbox. Chained hops plus the
-- five-minute cron would otherwise overlap and double-spend the same desk.

create table if not exists seer.worker_leases (
  account_id uuid not null references seer.mail_accounts (id) on delete cascade,
  kind text not null check (kind in ('read', 'sync')),
  expires_at timestamptz not null,
  primary key (account_id, kind)
);

create index if not exists worker_leases_expires_idx
  on seer.worker_leases (expires_at);

alter table seer.worker_leases enable row level security;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'seer_app') then
    grant select, insert, update, delete on seer.worker_leases to seer_app;

    execute 'drop policy if exists seer_app_worker_leases on seer.worker_leases';
    execute $policy$
      create policy seer_app_worker_leases on seer.worker_leases
        for all to seer_app
        using (true)
        with check (true)
    $policy$;
  end if;
end $$;
