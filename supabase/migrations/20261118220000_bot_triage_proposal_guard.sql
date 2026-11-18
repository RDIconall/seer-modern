-- The bot proposes; only Conall's approval executes. Once a proposal is in
-- front of him the bot must not be able to change what it would do, nor mark
-- it approved or executed. The bot may insert pending proposals and withdraw
-- a pending one (status = 'rejected', decided_by = 'bot') or delete it.

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'seer_bot') then
    execute 'revoke update on table seer.triage_proposals from seer_bot';
    execute 'grant select, insert, delete on table seer.triage_proposals to seer_bot';
    execute 'grant update (status, decided_by, decided_at) on table seer.triage_proposals to seer_bot';

    execute 'drop policy if exists seer_bot_triage_proposals on seer.triage_proposals';
    execute 'drop policy if exists seer_bot_triage_proposals_select on seer.triage_proposals';
    execute 'drop policy if exists seer_bot_triage_proposals_insert on seer.triage_proposals';
    execute 'drop policy if exists seer_bot_triage_proposals_update on seer.triage_proposals';
    execute 'drop policy if exists seer_bot_triage_proposals_delete on seer.triage_proposals';

    execute $policy$
      create policy seer_bot_triage_proposals_select on seer.triage_proposals
        for select to seer_bot using (true)
    $policy$;
    execute $policy$
      create policy seer_bot_triage_proposals_insert on seer.triage_proposals
        for insert to seer_bot
        with check (
          status = 'pending'
          and decided_at is null
          and decided_by is null
          and last_error is null
          and outbox_id is null
        )
    $policy$;
    execute $policy$
      create policy seer_bot_triage_proposals_update on seer.triage_proposals
        for update to seer_bot
        using (status = 'pending')
        with check (
          (status = 'pending' and decided_by is null)
          or (status = 'rejected' and decided_by = 'bot')
        )
    $policy$;
    execute $policy$
      create policy seer_bot_triage_proposals_delete on seer.triage_proposals
        for delete to seer_bot using (status = 'pending')
    $policy$;
  end if;
end $$;
