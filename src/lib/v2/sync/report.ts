import type { MailAccount } from "../db/accounts";
import type { MailProvider, SyncFolder } from "../providers/types";
import { syncFolder, type SyncMode } from "./engine";

export type SyncFolderReport = {
  email: string;
  folder: SyncFolder;
  traceId?: string;
  error?: string;
  providerTotal?: number;
  stored?: number;
  pending?: number;
  failed?: number;
};

export async function syncAccountFolders(
  account: MailAccount,
  provider: MailProvider,
  mode: SyncMode,
  folders: SyncFolder[],
): Promise<SyncFolderReport[]> {
  const report: SyncFolderReport[] = [];
  for (const folder of folders) {
    try {
      const run = await syncFolder(account.id, provider, folder, mode);
      report.push({
        email: account.email,
        folder,
        traceId: run.traceId,
        ...run.coverage,
      });
    } catch (e) {
      report.push({
        email: account.email,
        folder,
        error: e instanceof Error ? e.message.slice(0, 160) : "sync failed",
      });
    }
  }
  return report;
}
