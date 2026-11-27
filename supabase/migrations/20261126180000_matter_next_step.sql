-- A matter's next step is normally Seer's reading of the newest conversation
-- (the decision's `ask`). When the person edits it, their wording wins and is
-- kept here so a later re-read cannot overwrite it.
alter table seer.matters
  add column if not exists next_step_user text,
  add column if not exists next_step_user_at timestamptz;
