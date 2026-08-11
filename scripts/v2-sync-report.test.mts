/**
 * Sync cron report helper: per-folder failures must not discard sibling successes.
 */
import assert from "node:assert/strict";
import { startTestDb } from "./v2-testdb.mts";
import { upsertUser, upsertAccount } from "../src/lib/v2/db/accounts.ts";
import type { MailProvider, SyncFolder, SyncPage } from "../src/lib/v2/providers/types.ts";
import { syncAccountFolders } from "../src/lib/v2/sync/report.ts";

class FlakyProvider implements MailProvider {
  readonly kind = "google" as const;

  async sync(): Promise<SyncPage> {
    return this.syncFolder("inbox");
  }

  async syncFolder(folder: SyncFolder): Promise<SyncPage> {
    if (folder === "sent") throw new Error("sent folder unavailable");
    return {
      conversations: [],
      deletedConversationIds: [],
      nextCursor: null,
      providerTotal: 0,
    };
  }

  async getConversation(): Promise<never> {
    throw new Error("not implemented");
  }
  async search(): Promise<never> {
    throw new Error("not implemented");
  }
  async send(): Promise<never> {
    throw new Error("not implemented");
  }
  async reply(): Promise<never> {
    throw new Error("not implemented");
  }
  async forward(): Promise<never> {
    throw new Error("not implemented");
  }
  async mutateConversation(): Promise<never> {
    throw new Error("not implemented");
  }
  nativeUrl(): string {
    return "https://mail.google.com";
  }
}

const db = await startTestDb();
try {
  const userId = await upsertUser("report@example.com");
  const accountId = await upsertAccount({
    userId,
    provider: "google",
    email: "report@example.com",
  });
  const account = {
    id: accountId,
    userId,
    provider: "google" as const,
    email: "report@example.com",
    displayName: null,
  };

  const report = await syncAccountFolders(
    account,
    new FlakyProvider(),
    "incremental",
    ["inbox", "sent", "trash"],
  );

  assert.equal(report.length, 3);
  assert.equal(report[0].folder, "inbox");
  assert.ok(report[0].traceId, "inbox success must be retained");
  assert.equal(report[1].folder, "sent");
  assert.match(report[1].error ?? "", /sent folder unavailable/);
  assert.equal(report[2].folder, "trash");
  assert.ok(report[2].traceId, "trash success must be retained after sent failure");

  console.log("v2-sync-report: OK");
} finally {
  await db.stop();
}
