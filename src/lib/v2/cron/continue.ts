/**
 * Whether a per-mailbox worker should start another invocation immediately.
 * The 5-minute cron is the heartbeat; chaining is how a large inbox finishes
 * in hours instead of days without sharing anyone else's pipe.
 *
 * The next hop is kicked after the response so this invocation can return.
 * We only wait long enough to flush the request — awaiting the child hop
 * would nest 250s lambdas inside `after()` and blow the parent's budget.
 */

const NEXT_HOP_FLUSH_MS = 3_000;

export function shouldContinueRead(report: {
  decided?: number;
  error?: string;
  skipped?: string;
}): boolean {
  return !report.error && !report.skipped && (report.decided ?? 0) > 0;
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
