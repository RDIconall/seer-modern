import type { AccountId } from "../db/types";
import type { MailProvider } from "../providers/types";
import { syncAccount, type SyncRun } from "./engine";

/**
 * Reconciliation entry point. Push/webhook ingress is primary; this is the
 * safety net that re-drains an account to repair missed events and finish the
 * initial corpus. It runs the same engine — there is no second, divergent sync
 * path, and it never invokes any legacy classifier.
 */
export async function reconcileAccount(
  accountId: AccountId,
  provider: MailProvider,
): Promise<SyncRun> {
  return syncAccount(accountId, provider, "incremental");
}
