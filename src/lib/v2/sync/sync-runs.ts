import { db } from "../db/pool";
import type { AccountId } from "../db/types";
import type { SyncFolder } from "../providers/types";
import type { Coverage } from "./repository";
import type { SyncMode } from "./engine";

export type SyncRunTelemetry = {
  accountId: AccountId;
  traceId: string;
  mode: SyncMode;
  folder: SyncFolder;
  coverage: Coverage;
  complete: boolean;
  started: Date;
};

function isUndefinedColumnError(err: unknown): boolean {
  return (
    err instanceof Error &&
    "code" in err &&
    (err as { code?: string }).code === "42703"
  );
}

/**
 * Best-effort sync run telemetry. Never throws — a missing migration or column
 * must not undo committed page/cursor writes.
 */
export async function recordSyncRun(
  input: SyncRunTelemetry,
): Promise<string | undefined> {
  const { accountId, traceId, mode, folder, coverage, complete, started } =
    input;
  const baseParams = [
    accountId,
    traceId,
    mode,
    coverage.providerTotal,
    coverage.stored,
    coverage.pending,
    coverage.failed,
    started,
  ] as const;

  try {
    await db().query(
      `insert into seer.sync_runs
         (account_id, trace_id, mode, folder, provider_total, stored, pending, failed, complete, started_at, finished_at)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, now())`,
      [
        accountId,
        traceId,
        mode,
        folder,
        coverage.providerTotal,
        coverage.stored,
        coverage.pending,
        coverage.failed,
        complete,
        started,
      ],
    );
    return undefined;
  } catch (err) {
    if (!isUndefinedColumnError(err)) {
      return err instanceof Error ? err.message.slice(0, 200) : "sync_runs insert failed";
    }
  }

  try {
    await db().query(
      `insert into seer.sync_runs
         (account_id, trace_id, mode, provider_total, stored, pending, failed, started_at, finished_at)
         values ($1, $2, $3, $4, $5, $6, $7, $8, now())`,
      [...baseParams],
    );
    return undefined;
  } catch (err) {
    return err instanceof Error ? err.message.slice(0, 200) : "sync_runs legacy insert failed";
  }
}
