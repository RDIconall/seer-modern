import type { Command, CommandResult } from "../commands/types";
import type { AccountId } from "../db/types";
import { isMissingRelation } from "../db/missing";
import { notifyStaffWebhook } from "../staff/webhook";
import { accountEmail } from "../staff/repository";
import {
  createWhiteboardItem,
  updateWhiteboardItem,
  whiteboardTablesReady,
} from "./repository";
import { isWhiteboardItemStatus } from "./types";

export type WhiteboardCommandContext = {
  accountId: AccountId;
};

export function isWhiteboardCommand(command: Command): boolean {
  return (
    command.type === "createWhiteboardItem" ||
    command.type === "updateWhiteboardItem"
  );
}

function fail(error: string): CommandResult {
  return { ok: false, replayed: false, error };
}

function ok(detail?: Record<string, unknown>): CommandResult {
  return { ok: true, replayed: false, detail };
}

async function ping(
  ctx: WhiteboardCommandContext,
  event: "whiteboard_item.created" | "whiteboard_item.updated",
  item: { id: string; title: string; status: string; sectionSlug: string },
): Promise<void> {
  const email = await accountEmail(ctx.accountId);
  await notifyStaffWebhook({
    event,
    accountId: ctx.accountId,
    accountEmail: email,
    occurredAt: new Date().toISOString(),
    itemId: item.id,
    item: {
      id: item.id,
      title: item.title,
      status: item.status,
      sectionSlug: item.sectionSlug,
    },
  });
}

export async function runWhiteboardCommand(
  ctx: WhiteboardCommandContext,
  command: Command,
): Promise<CommandResult> {
  if (!(await whiteboardTablesReady())) {
    return fail("whiteboard tables are not migrated yet");
  }
  try {
    switch (command.type) {
      case "createWhiteboardItem": {
        const item = await createWhiteboardItem({
          accountId: ctx.accountId,
          sectionSlug: command.sectionSlug,
          title: command.title,
          body: command.body,
          status: command.status,
          priority: command.priority,
          dueAt: command.dueAt,
          ownerLabel: command.ownerLabel,
          conversationId: command.conversationId,
          externalKey: command.externalKey,
          source: "user",
        });
        await ping(ctx, "whiteboard_item.created", item);
        return ok({
          itemId: item.id,
          title: item.title,
          sectionSlug: item.sectionSlug,
        });
      }
      case "updateWhiteboardItem": {
        if (command.status && !isWhiteboardItemStatus(command.status)) {
          return fail("invalid status");
        }
        const item = await updateWhiteboardItem(ctx.accountId, command.itemId, {
          title: command.title,
          body: command.body,
          status: command.status,
          sectionSlug: command.sectionSlug,
          priority: command.priority,
          dueAt: command.dueAt,
          ownerLabel: command.ownerLabel,
          conversationId: command.conversationId,
        });
        await ping(ctx, "whiteboard_item.updated", item);
        return ok({
          itemId: item.id,
          status: item.status,
          sectionSlug: item.sectionSlug,
        });
      }
      default:
        return fail("not a whiteboard command");
    }
  } catch (cause) {
    if (isMissingRelation(cause)) {
      return fail("whiteboard tables are not migrated yet");
    }
    return fail(cause instanceof Error ? cause.message : "whiteboard command failed");
  }
}
