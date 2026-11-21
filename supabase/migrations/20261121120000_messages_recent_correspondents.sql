-- Compose recipient suggestions walk an account's most recent messages one
-- index entry at a time, newest first, and stop after a fixed count. The id
-- column breaks sent_at ties so the walk never revisits or skips a row.

create index if not exists messages_account_sent_idx
  on seer.messages (account_id, sent_at desc, id desc)
  where sent_at is not null;
