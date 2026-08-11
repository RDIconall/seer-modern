-- Final-review follow-ups:
--   * make the application role usable but non-inheriting (operators provision
--     its password separately)
--   * replace numeric snapshot generations with opaque durable UUIDs
--   * add per-account OAuth health metadata

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'seer_app') then
    create role seer_app login noinherit;
  else
    alter role seer_app login noinherit;
  end if;
end $$;

alter table seer.folder_sync_state
  add column if not exists snapshot_generation uuid
    default gen_random_uuid();

update seer.folder_sync_state
   set snapshot_generation = gen_random_uuid()
 where snapshot_generation is null;

alter table seer.folder_sync_state
  alter column snapshot_generation set default gen_random_uuid(),
  alter column snapshot_generation set not null;

do $$
begin
  if exists (
    select 1
      from information_schema.tables
     where table_schema = 'seer' and table_name = 'folder_sync_seen'
  ) then
    execute 'drop index if exists seer.folder_sync_seen_lookup_idx';
    execute 'alter table seer.folder_sync_seen add column if not exists snapshot_generation uuid';
    if exists (
      select 1
        from information_schema.columns
       where table_schema = 'seer'
         and table_name = 'folder_sync_seen'
         and column_name = 'scan_generation'
    ) then
      execute $sql$
        update seer.folder_sync_seen seen
           set snapshot_generation = state.snapshot_generation
          from seer.folder_sync_state state
         where state.account_id = seen.account_id
           and state.folder = seen.folder
           and state.scan_generation = seen.scan_generation
      $sql$;
    end if;
    execute 'delete from seer.folder_sync_seen where snapshot_generation is null';
    execute 'alter table seer.folder_sync_seen alter column snapshot_generation set not null';
    execute 'alter table seer.folder_sync_seen drop constraint if exists folder_sync_seen_pkey';
    execute $sql$
      alter table seer.folder_sync_seen
        add primary key (account_id, folder, snapshot_generation, provider_conversation_id)
    $sql$;
    if exists (
      select 1
        from information_schema.columns
       where table_schema = 'seer'
         and table_name = 'folder_sync_seen'
         and column_name = 'scan_generation'
    ) then
      execute 'alter table seer.folder_sync_seen drop column scan_generation';
    end if;
    execute $sql$
      create index folder_sync_seen_lookup_idx
        on seer.folder_sync_seen (account_id, folder, snapshot_generation)
    $sql$;
  end if;
end $$;

do $$
begin
  if exists (
    select 1
      from information_schema.columns
     where table_schema = 'seer'
       and table_name = 'folder_sync_state'
       and column_name = 'scan_generation'
  ) then
    alter table seer.folder_sync_state drop column scan_generation;
  end if;
end $$;

alter table seer.oauth_credentials
  add column if not exists status text not null default 'active'
    check (status in ('active', 'reconnect_required')),
  add column if not exists last_error text;
