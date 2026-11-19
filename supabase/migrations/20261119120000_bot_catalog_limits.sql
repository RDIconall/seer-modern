-- seer.bots is a shared catalog rendered in every desk's delegate picker.
-- Cap slug and display name so no writer can store unbounded labels.
-- Added NOT VALID so a deploy never fails on a pre-existing oversized row;
-- new writes are checked either way, and the block below validates when it can.

alter table seer.bots drop constraint if exists bots_slug_length;
alter table seer.bots
  add constraint bots_slug_length check (char_length(slug) <= 128) not valid;

alter table seer.bots drop constraint if exists bots_display_name_length;
alter table seer.bots
  add constraint bots_display_name_length check (char_length(display_name) <= 128) not valid;

do $$
begin
  alter table seer.bots validate constraint bots_slug_length;
exception
  when check_violation then null;
end $$;

do $$
begin
  alter table seer.bots validate constraint bots_display_name_length;
exception
  when check_violation then null;
end $$;
