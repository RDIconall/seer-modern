/** Parallelism per request — Gmail per-user quota tolerates ~10-15 writes/s. */
export const PROVIDER_CONCURRENCY = 15;

/**
 * Most rows one mailbox-action request may name. Callers with more send
 * several requests, so a single invocation's provider work stays small.
 */
export const MAX_ACTION_ROWS = 25;

export type Limiter = <R>(task: () => Promise<R>) => Promise<R>;

/**
 * At most `max` tasks run at once; the rest wait their turn. Share one
 * limiter across nested fan-outs (a thread action that acts on each of its
 * messages) so the whole request stays inside one bound. A task must not
 * wait on another task of the same limiter, or it can deadlock.
 */
export function createLimiter(max = PROVIDER_CONCURRENCY): Limiter {
  let active = 0;
  const queue: (() => void)[] = [];
  const next = () => {
    while (active < max && queue.length) {
      active += 1;
      queue.shift()!();
    }
  };
  return <R>(task: () => Promise<R>) =>
    new Promise<R>((resolve, reject) => {
      queue.push(() => {
        Promise.resolve()
          .then(task)
          .then(resolve, reject)
          .finally(() => {
            active -= 1;
            next();
          });
      });
      next();
    });
}
