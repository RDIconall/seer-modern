-- A Triage correction teaches Seer about one sender. That sender is fixed when
-- the user acts, from the message the row showed them; it is never re-derived
-- from whatever From header arrives on the conversation afterwards.
alter table seer.conversation_decisions
  add column if not exists placement_sender text;

-- Existing corrections keep their lesson only where the row's message at the
-- time of the correction was inbound. `created_at` is when Seer stored the
-- message, so mail that had not synced yet is not something the user saw.
update seer.conversation_decisions d
   set placement_sender = (
         select lower(btrim(latest.from_email))
           from (
             select m.from_email, m.is_outgoing
               from seer.messages m
              where m.account_id = d.account_id
                and m.conversation_id = d.conversation_id
                and m.created_at <= d.decided_at
              order by m.sent_at desc nulls last, m.provider_message_id desc
              limit 1
           ) latest
          where latest.is_outgoing = false
            and nullif(btrim(coalesce(latest.from_email, '')), '') is not null
       )
 where d.model_version = 'user-correction'
   and d.is_current
   and d.placement_sender is null;
