-- One brief rebuild per mailbox, with a cooldown after it ends. Each rebuild
-- fans out to many calls on the deployment's shared model key.

alter table seer.worker_leases
  drop constraint if exists worker_leases_kind_check;

alter table seer.worker_leases
  add constraint worker_leases_kind_check
  check (kind in ('read', 'sync', 'brief'));
