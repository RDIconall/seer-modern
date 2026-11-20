-- body_text kept a multipart/alternative message's text/plain part even when
-- the reader shows its text/html part, so reads graded words the person never
-- saw. storedBodyText now stores the HTML part's text whenever it has any.
-- Re-derive it for rows written before that, inside the database so
-- body_html never leaves it. HTML without text keeps its text part, as in
-- storedBodyText. The next sync of a conversation replaces this approximation
-- with the app's own htmlToText output.
--
-- Every quantifier is non-greedy: a Postgres RE takes its greediness from the
-- first quantifier, and a greedy match would swallow the text between two
-- <style> blocks.

with derived as (
  select id,
         btrim(regexp_replace(
           replace(replace(replace(replace(replace(replace(
             regexp_replace(
               regexp_replace(
                 regexp_replace(
                   regexp_replace(
                     regexp_replace(
                       regexp_replace(body_html, '<!--.*?-->', ' ', 'g'),
                       '<script\M[^>]*?>.*?</script\s*?>', ' ', 'gi'),
                     '<style\M[^>]*?>.*?</style\s*?>', ' ', 'gi'),
                   '<head\M[^>]*?>.*?</head\s*?>', ' ', 'gi'),
                 '<noscript\M[^>]*?>.*?</noscript\s*?>', ' ', 'gi'),
               '<[^>]*?>', ' ', 'g'),
             '&nbsp;', ' '), '&lt;', '<'), '&gt;', '>'),
             '&quot;', '"'), '&#39;', ''''), '&amp;', '&'),
           '\s+', ' ', 'g')) as shown_text
    from seer.messages
   where nullif(btrim(coalesce(body_html, '')), '') is not null
)
update seer.messages m
   set body_text = d.shown_text
  from derived d
 where m.id = d.id
   and d.shown_text <> ''
   and m.body_text is distinct from d.shown_text;
