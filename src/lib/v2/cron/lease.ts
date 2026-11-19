import { db } from "../db/pool";
import type { AccountId } from "../db/types";

/** Background pipes that must not overlap on one mailbox. */
export type WorkerKind = "read" | "sync";

/** Longer than one 250s hop, shorter than two cron ticks. */
export const WORKER_LEASE_MS = 5 * 60_000;

/**
 * A lease this worker acquired. `fence` is the exact expiry the claim wrote;
 * every later claim (including a steal after expiry) writes a new one, so it
 * identifies this holder and no other.
 */
export type WorkerLease = {
  accountId: AccountId;
  kind: WorkerKind;
  fence: string;
};

/**
 * Take the mailbox pipe, or refuse if another hop still holds it. An expired
 * row is stolen so a killed lambda cannot stall the desk until morning.
 */
export async function acquireWorkerLease(
  accountId: AccountId,
  kind: WorkerKind,
  leaseMs = WORKER_LEASE_MS,
): Promise<WorkerLease | null> {
  const result = await db().query<{ fence: string }>(
    `insert into seer.worker_leases (account_id, kind, expires_at)
     values ($1, $2, now() + make_interval(secs => $3))
     on conflict (account_id, kind) do update
       set expires_at = excluded.expires_at
     where seer.worker_leases.expires_at < now()
     returning expires_at::text as fence`,
    [accountId, kind, leaseMs / 1000],
  );
  const fence = result.rows[0]?.fence;
  return fence ? { accountId, kind, fence } : null;
}

/**
 * Take every kind or none. A partial claim is handed back before returning
 * so a refused worker never leaves a pipe blocked.
 */
export async function acquireWorkerLeases(
  accountId: AccountId,
  kinds: readonly WorkerKind[],
  leaseMs = WORKER_LEASE_MS,
): Promise<WorkerLease[] | null> {
  const held: WorkerLease[] = [];
  for (const kind of kinds) {
    const lease = await acquireWorkerLease(accountId, kind, leaseMs);
    if (!lease) {
      await releaseWorkerLeases(held);
      return null;
    }
    held.push(lease);
  }
  return held;
}

/** Compare-and-delete: a lease another worker has since taken is left alone. */
export async function releaseAcquiredLease(lease: WorkerLease): Promise<void> {
  await db().query(
    `delete from seer.worker_leases
      where account_id = $1 and kind = $2 and expires_at = $3::timestamptz`,
    [lease.accountId, lease.kind, lease.fence],
  );
}

export async function releaseWorkerLeases(
  leases: readonly WorkerLease[],
): Promise<void> {
  for (const lease of [...leases].reverse()) {
    await releaseAcquiredLease(lease);
  }
}

export async function claimWorkerLease(
  accountId: AccountId,
  kind: WorkerKind,
  leaseMs = WORKER_LEASE_MS,
): Promise<boolean> {
  return (await acquireWorkerLease(accountId, kind, leaseMs)) !== null;
}

/**
 * Unfenced delete for operators and tests. Workers release through
 * `releaseAcquiredLease` so a slow hop cannot drop a newer holder's lease.
 */
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
