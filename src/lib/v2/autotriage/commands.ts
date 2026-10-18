import { cancelPending, enqueueOptimistic } from "@/lib/v3/outbox/repository";
import type { CommandResult } from "../commands/types";
import { isUuid, type AccountId } from "../db/types";
import {
  ensureSettings,
  getLog,
  markLogUndone,
  setAutoTriageMode,
  upsertSenderRule,
} from "./repository";
import type { AutoTriageMode } from "./types";

function fail(error: string): CommandResult {
  return { ok: false, replayed: false, error };
}

function ok(detail?: Record<string, unknown>, outboxId?: string): CommandResult {
  return { ok: true, replayed: false, detail, outboxId };
}

export async function undoAutoTriageCommand(
  accountId: AccountId,
  logId: string,
): Promise<CommandResult> {
  if (!isUuid(logId)) return fail("log not found");
  const log = await getLog(accountId, logId);
  if (!log) return fail("log not found");
  if (log.undoneAt) return ok({ logId, undone: true });

  if (log.outboxId) {
    const cancelled = await cancelPending(accountId, log.outboxId);
    if (cancelled) {
      await markLogUndone(accountId, logId);
      return ok({ logId, cancelled: true });
    }
    if (log.conversationId) {
      const restore = await enqueueOptimistic(
        accountId,
        { type: "restore", conversationId: log.conversationId },
        `autotriage-undo:${logId}`,
      );
      await markLogUndone(accountId, logId, restore.id);
      return ok({ logId, restored: true }, restore.id);
    }
  }

  await markLogUndone(accountId, logId);
  return ok({ logId, undone: true });
}

export async function alwaysKeepSenderCommand(
  accountId: AccountId,
  sender: string,
  logId?: string | null,
): Promise<CommandResult> {
  const addr = sender.trim().toLowerCase();
  if (!addr || !addr.includes("@")) return fail("sender is required");
  await upsertSenderRule(accountId, addr, "always_keep", "user");
  let undo: CommandResult | null = null;
  if (logId) {
    undo = await undoAutoTriageCommand(accountId, logId);
    if (!undo.ok) return undo;
  }
  return ok({ sender: addr, undone: Boolean(undo?.ok), logId: logId ?? null }, undo?.outboxId);
}

export async function setAutoTriageModeCommand(
  accountId: AccountId,
  mode: AutoTriageMode,
): Promise<CommandResult> {
  if (mode !== "off" && mode !== "dry_run" && mode !== "live") {
    return fail("invalid mode");
  }
  const settings = await setAutoTriageMode(accountId, mode);
  const current = await ensureSettings(accountId);
  return ok({
    mode: settings.mode,
    aiEnabled: current.aiEnabled,
    envMode: (process.env.SEER_AUTOTRIAGE ?? "dry_run").trim() || "dry_run",
  });
}
