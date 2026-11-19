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

/** A rebuild still holding the brief lease after this long is presumed dead. */
export const BRIEF_REBUILD_LEASE_MS = 5 * 60_000;
/** Minimum quiet time after a brief rebuild before the mailbox can start one. */
export const BRIEF_REBUILD_COOLDOWN_MS = 2 * 60_000;

/**
 * Take the mailbox's brief rebuild, or refuse while one is running or cooling
 * down. Returns a token that only this claim can use to end it.
 */
export async function claimBriefRebuild(
  accountId: AccountId,
): Promise<string | null> {
  const result = await db().query<{ token: string }>(
    `insert into seer.worker_leases (account_id, kind, expires_at)
     values ($1, 'brief', now() + make_interval(secs => $2))
     on conflict (account_id, kind) do update
       set expires_at = excluded.expires_at
     where seer.worker_leases.expires_at < now()
     returning expires_at::text as token`,
    [accountId, BRIEF_REBUILD_LEASE_MS / 1000],
  );
  return result.rows[0]?.token ?? null;
}

/** End a brief rebuild: the lease stays held for the cooldown, then lapses. */
export async function finishBriefRebuild(
  accountId: AccountId,
  token: string,
): Promise<void> {
  await db().query(
    `update seer.worker_leases
        set expires_at = now() + make_interval(secs => $3)
      where account_id = $1 and kind = 'brief'
        and expires_at = $2::timestamptz`,
    [accountId, token, BRIEF_REBUILD_COOLDOWN_MS / 1000],
  );
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
