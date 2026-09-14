/**
 * Whether a per-mailbox worker should start another invocation immediately.
 * The 5-minute cron is the heartbeat; chaining is how a large inbox finishes
 * in hours instead of days without sharing anyone else's pipe.
 *
 * Chaining is for a mailbox that demonstrably has more work than one hop can
 * hold. A hop that finished everything waiting must stop: kicking a successor
 * to discover an empty queue is an invocation spent on nothing, and with one
 * per mailbox per tick that is what turns ordinary mail into a usage spike.
 *
 * The next hop is kicked after the response so this invocation can return.
 * We only wait long enough to flush the request — awaiting the child hop
 * would nest 250s lambdas inside `after()` and blow the parent's budget.
 */

const NEXT_HOP_FLUSH_MS = 3_000;

/**
 * Ceiling on one tick's chain. Catch-up is allowed to run long, but never
 * unbounded: a bug that keeps reporting progress costs at most this many
 * invocations before the next scheduled tick has to re-earn the work.
 */
export const MAX_CHAINED_HOPS = 12;

export function shouldContinueRead(report: {
  decided?: number;
  queued?: number;
  limit?: number;
  error?: string;
  skipped?: string;
}): boolean {
  if (report.error || report.skipped) return false;
  if ((report.decided ?? 0) <= 0) return false;
  // A queue shorter than the cap was drained by this hop; only a full batch
  // is evidence that mail is still waiting.
  const limit = report.limit ?? 0;
  return limit > 0 && (report.queued ?? 0) >= limit;
}

export function shouldContinueSync(
  rows: readonly Record<string, unknown>[],
): boolean {
  const folders = rows.filter((row) => typeof row.folder === "string");
  const targets = folders.length > 0 ? folders : rows;
  if (targets.some((row) => typeof row.error === "string" && row.error)) {
    return false;
  }
  const progressed = targets.some(
    (row) => typeof row.pages === "number" && row.pages > 0,
  );
  const unfinished = targets.some((row) => row.backfillComplete !== true);
  return progressed && unfinished;
}

/**
 * The URL of the next hop in this chain, or null once the chain has run its
 * length. The hop count rides on the worker URL so it survives the process
 * boundary between one invocation and the next.
 */
export function nextHopUrl(
  currentUrl: string,
  maxHops = MAX_CHAINED_HOPS,
): string | null {
  const url = new URL(currentUrl);
  const raw = Number(url.searchParams.get("hop") ?? "0");
  const hop = Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 0;
  if (hop + 1 > maxHops) return null;
  url.searchParams.set("hop", String(hop + 1));
  return url.toString();
}

/** Start the next hop; resolve once the request is on the wire. */
export async function kickNextHop(
  url: string,
  auth: string | null,
): Promise<void> {
  const pending = fetch(url, {
    headers: {
      accept: "application/json",
      ...(auth ? { authorization: auth } : {}),
    },
    cache: "no-store",
  }).then(
    (response) =>
      response.body?.cancel().then(
        () => undefined,
        () => undefined,
      ) ?? undefined,
    () => undefined,
  );
  await Promise.race([
    pending,
    new Promise<void>((resolve) => setTimeout(resolve, NEXT_HOP_FLUSH_MS)),
  ]);
}
