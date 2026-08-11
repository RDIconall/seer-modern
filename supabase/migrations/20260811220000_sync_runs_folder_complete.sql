-- sync_runs: per-folder visibility for bounded multi-folder sync ticks.

alter table seer.sync_runs
  add column if not exists folder text check (folder in ('inbox', 'sent', 'trash'));

alter table seer.sync_runs
  add column if not exists complete boolean;
