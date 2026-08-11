-- Distinguish historical backfill (page cursor) from steady-state head polling.

alter table seer.folder_sync_state
  add column if not exists backfill_complete boolean not null default false;

-- Rows that already finished draining stored cursor=null; treat as backfill-complete.
update seer.folder_sync_state
   set backfill_complete = true
 where cursor is null
   and provider_total > 0;
