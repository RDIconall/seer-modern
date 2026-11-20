/**
 * Wall-clock budget for a worker hop. The hop's lease outlives its deadline by
 * less than one model call's own timeout, so a call started near the deadline
 * must also be cut off at it, or the next hop could take the lease while this
 * one is still writing.
 */

const MODEL_CALL_TIMEOUT_MS = 60_000;

export function pastDeadline(deadlineMs: number | undefined): boolean {
  return deadlineMs !== undefined && Date.now() >= deadlineMs;
}

export function modelCallSignal(deadlineMs: number | undefined): AbortSignal {
  const timeout = AbortSignal.timeout(MODEL_CALL_TIMEOUT_MS);
  if (deadlineMs === undefined) return timeout;
  return AbortSignal.any([
    timeout,
    AbortSignal.timeout(Math.max(1, deadlineMs - Date.now())),
  ]);
}
