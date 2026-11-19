-- Login catch-up must not sync beside a worker that holds the mailbox's sync
-- lease. When it is refused it leaves a request here, and the holder polls
-- the inbox head between its own pages, so new mail is not hidden behind an
-- unfinished backfill.

create table if not exists seer.inbox_head_poll_requests (
  account_id uuid primary key references seer.mail_accounts (id) on delete cascade,
  requested_at timestamptz not null default now()
);

alter table seer.inbox_head_poll_requests enable row level security;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'seer_app') then
    grant select, insert, update, delete on seer.inbox_head_poll_requests to seer_app;

    execute 'drop policy if exists seer_app_inbox_head_poll_requests on seer.inbox_head_poll_requests';
    execute $policy$
      create policy seer_app_inbox_head_poll_requests on seer.inbox_head_poll_requests
        for all to seer_app
        using (true)
        with check (true)
    $policy$;
  end if;
end $$;
