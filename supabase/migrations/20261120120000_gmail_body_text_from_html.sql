-- Gmail body_text used to hold a message's text/plain part even when the
-- message also had an HTML part, so the chief-of-staff read graded a part the
-- reading pane never shows. body_text is now derived from body_html whenever
-- one exists. Clear the stale copies: reads fall back to body_html until the
-- next sync of the conversation rewrites body_text from it.
--
-- Outlook keeps a single body per message, so its derived text is left alone.

update seer.messages m
   set body_text = null
  from seer.mail_accounts a
 where a.id = m.account_id
   and a.provider = 'google'
   and m.body_text is not null
   and nullif(btrim(coalesce(m.body_html, '')), '') is not null;
