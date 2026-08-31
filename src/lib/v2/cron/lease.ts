import { db } from "../db/pool";
import type { AccountId } from "../db/types";

/** Background pipes that must not overlap on one mailbox. */
export type WorkerKind = "read" | "sync";

/** Longer than one 250s hop, shorter than two cron ticks. */
export const WORKER_LEASE_MS = 5 * 60_000;

/**
 * Take the mailbox pipe, or refuse if another hop still holds it. An expired
 * row is stolen so a killed lambda cannot stall the desk until morning.
 */
export async function claimWorkerLease(
  accountId: AccountId,
  kind: WorkerKind,
  leaseMs = WORKER_LEASE_MS,
): Promise<boolean> {
  const result = await db().query(
    `insert into seer.worker_leases (account_id, kind, expires_at)
     values ($1, $2, now() + make_interval(secs => $3))
     on conflict (account_id, kind) do update
       set expires_at = excluded.expires_at
     where seer.worker_leases.expires_at < now()
     returning account_id`,
    [accountId, kind, leaseMs / 1000],
  );
  return (result.rowCount ?? 0) > 0;
}

export async function releaseWorkerLease(
  accountId: AccountId,
  kind: WorkerKind,
): Promise<void> {
  await db().query(
    `delete from seer.worker_leases
      where account_id = $1 and kind = $2`,
    [accountId, kind],
  );
}
