-- Atlas keeps a compact, user-facing phrase separate from the durable
-- inferred matter title. User-authored phrases are never overwritten.
alter table seer.matters
  add column if not exists short_title text,
  add column if not exists short_title_source text
    not null default 'inferred'
    check (short_title_source in ('inferred', 'user')),
  add column if not exists short_title_version integer;

create index if not exists matters_short_title_refresh_idx
  on seer.matters (account_id, short_title_source, short_title_version);
