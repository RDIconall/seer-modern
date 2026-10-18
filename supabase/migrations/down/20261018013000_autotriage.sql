-- Reverse of 20261018013000_autotriage.sql

drop policy if exists seer_app_triage_sender_rules on seer.triage_sender_rules;
drop policy if exists seer_bot_triage_sender_rules on seer.triage_sender_rules;
drop policy if exists seer_app_autotriage_log on seer.autotriage_log;
drop policy if exists seer_bot_autotriage_log on seer.autotriage_log;
drop policy if exists seer_app_autotriage_state on seer.autotriage_state;
drop policy if exists seer_bot_autotriage_state on seer.autotriage_state;
drop policy if exists seer_app_autotriage_settings on seer.autotriage_settings;
drop policy if exists seer_bot_autotriage_settings on seer.autotriage_settings;

drop table if exists seer.triage_sender_rules;
drop table if exists seer.autotriage_log;
drop table if exists seer.autotriage_state;
drop table if exists seer.autotriage_settings;
