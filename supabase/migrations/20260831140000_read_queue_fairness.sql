-- Read-queue backoff looks up model_usage by conversation. Without this index
-- a 16k inbox would sequential-scan usage on every cron tick.

create index if not exists model_usage_conversation_created_idx
  on seer.model_usage (conversation_id, created_at desc)
  where conversation_id is not null;
