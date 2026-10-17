import type { Command, CommandResult } from "../commands/types";
import type { MailProvider } from "../providers/types";
import { enqueueOptimistic } from "@/lib/v3/outbox/repository";
import { isUuid, type AccountId } from "../db/types";
import {
  accountEmail,
  commentTask,
  createTask,
  getProposal,
  getTask,
  markProposal,
  postMessage,
  resolveConversation,
  updateTask,
} from "./repository";
import type { StaffTask } from "./types";
import { DEFAULT_BOT_SLUG, isBotTaskStatus } from "./types";
import { notifyStaffWebhook } from "./webhook";
import type { StaffWebhookEvent, StaffWebhookPayload } from "./webhook";

export type StaffCommandContext = {
  accountId: AccountId;
  provider?: MailProvider;
};

export function isStaffCommand(command: Command): boolean {
  return (
    command.type === "createBotTask" ||
    command.type === "updateBotTask" ||
    command.type === "commentBotTask" ||
    command.type === "postBotMessage" ||
    command.type === "decideTriageProposal"
  );
}

function fail(error: string): CommandResult {
  return { ok: false, replayed: false, error };
}

function ok(detail?: Record<string, unknown>): CommandResult {
  return { ok: true, replayed: false, detail };
}

function taskSummary(task: StaffTask): Record<string, unknown> {
  return {
    id: task.id,
    title: task.title,
    status: task.status,
    botSlug: task.botSlug,
    botName: task.botName,
    dueAt: task.dueAt,
    priority: task.priority,
  };
}

async function ping(
  ctx: StaffCommandContext,
  event: StaffWebhookEvent,
  extra: Partial<StaffWebhookPayload>,
): Promise<void> {
  const email = await accountEmail(ctx.accountId);
  await notifyStaffWebhook({
    event,
    accountId: ctx.accountId,
    accountEmail: email,
    occurredAt: new Date().toISOString(),
    taskId: extra.taskId ?? null,
    messageId: extra.messageId ?? null,
    proposalId: extra.proposalId ?? null,
    task: extra.task ?? null,
    message: extra.message ?? null,
    proposal: extra.proposal ?? null,
  });
}

export async function runStaffCommand(
  ctx: StaffCommandContext,
  command: Command,
  idempotencyKey: string,
): Promise<CommandResult> {
  switch (command.type) {
    case "createBotTask": {
      try {
        const task = await createTask({
          accountId: ctx.accountId,
          botSlug: command.botSlug ?? DEFAULT_BOT_SLUG,
          title: command.title,
          notes: command.notes,
          dueAt: command.dueAt,
          hisWords: command.hisWords,
          nextAction: command.nextAction,
          source: "user",
        });
        await ping(ctx, "bot_task.created", {
          taskId: task.id,
          task: taskSummary(task),
        });
        return ok({ taskId: task.id, title: task.title });
      } catch (cause) {
        return fail(cause instanceof Error ? cause.message : "could not create task");
      }
    }
    case "updateBotTask": {
      if (!isUuid(command.taskId)) return fail("task not found");
      const patch = {
        status: command.status,
        title: command.title,
        notes: command.notes,
        dueAt: command.dueAt,
        nextAction: command.nextAction,
        priority: command.priority,
        botSlug: command.botSlug,
      };
      if (patch.status && !isBotTaskStatus(patch.status)) {
        return fail("invalid status");
      }
      try {
        const task = await updateTask(ctx.accountId, command.taskId, patch, "user");
        await ping(ctx, "bot_task.updated", {
          taskId: task.id,
          task: taskSummary(task),
        });
        return ok({ taskId: task.id, status: task.status });
      } catch (cause) {
        return fail(cause instanceof Error ? cause.message : "could not update task");
      }
    }
    case "commentBotTask": {
      try {
        const event = await commentTask(
          ctx.accountId,
          command.taskId,
          command.body,
          "user",
        );
        const task = await getTask(ctx.accountId, command.taskId);
        await ping(ctx, "bot_task.commented", {
          taskId: command.taskId,
          task: task ? taskSummary(task) : null,
          message: { id: event.id, body: event.body, author: "user" },
        });
        return ok({ eventId: event.id });
      } catch (cause) {
        return fail(cause instanceof Error ? cause.message : "could not comment");
      }
    }
    case "postBotMessage": {
      try {
        const message = await postMessage({
          accountId: ctx.accountId,
          botSlug: command.botSlug,
          taskId: command.taskId ?? null,
          author: "user",
          body: command.body,
        });
        await ping(ctx, "bot_message.created", {
          taskId: message.taskId,
          messageId: message.id,
          message: {
            id: message.id,
            taskId: message.taskId,
            author: message.author,
            body: message.body,
            createdAt: message.createdAt,
          },
        });
        return ok({ messageId: message.id, threadTaskId: message.taskId });
      } catch (cause) {
        return fail(cause instanceof Error ? cause.message : "could not send");
      }
    }
    case "decideTriageProposal": {
      return decideProposal(ctx, command.proposalId, command.decision, idempotencyKey);
    }
    default:
      return fail("not a staff command");
  }
}

async function decideProposal(
  ctx: StaffCommandContext,
  proposalId: string,
  decision: "approved" | "rejected",
  idempotencyKey: string,
): Promise<CommandResult> {
  if (!isUuid(proposalId)) return fail("proposal not found");
  const proposal = await getProposal(ctx.accountId, proposalId);
  if (!proposal) return fail("proposal not found");
  if (proposal.status !== "pending") {
    return fail("proposal already decided");
  }

  if (decision === "rejected") {
    const updated = await markProposal(ctx.accountId, proposalId, {
      status: "rejected",
      decidedBy: "user",
    });
    await ping(ctx, "triage_proposal.decided", {
      proposalId,
      proposal: {
        id: updated.id,
        action: updated.action,
        status: updated.status,
      },
    });
    return ok({ proposalId, status: "rejected" });
  }

  try {
    const executed = await executeApproved(ctx, proposal, idempotencyKey);
    const updated = await markProposal(ctx.accountId, proposalId, {
      status: executed.ok ? "executed" : "failed",
      decidedBy: "user",
      lastError: executed.ok ? null : (executed.error ?? "execution failed"),
      outboxId: executed.outboxId ?? null,
    });
    await ping(ctx, "triage_proposal.decided", {
      proposalId,
      proposal: {
        id: updated.id,
        action: updated.action,
        status: updated.status,
        outboxId: updated.outboxId,
      },
    });
    if (!executed.ok) {
      return {
        ...executed,
        detail: { ...(executed.detail ?? {}), proposalId, status: updated.status },
      };
    }
    return {
      ...executed,
      detail: { ...(executed.detail ?? {}), proposalId, status: updated.status },
    };
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : "execution failed";
    await markProposal(ctx.accountId, proposalId, {
      status: "failed",
      decidedBy: "user",
      lastError: message,
    });
    return fail(message);
  }
}

async function executeApproved(
  ctx: StaffCommandContext,
  proposal: Awaited<ReturnType<typeof getProposal>> & {},
  idempotencyKey: string,
): Promise<CommandResult> {
  if (!proposal) return fail("proposal not found");
  const action = proposal.action;

  if (action === "keep") {
    return ok({ action: "keep" });
  }

  const conversation = await resolveConversation(
    ctx.accountId,
    proposal.conversationId,
    proposal.providerConversationId,
  );

  if (action === "file" || (action === "filtered" && proposal.destinationId)) {
    if (!proposal.destinationId) return fail("file needs a destination folder");
    if (!conversation) {
      return fail("conversation is not in Seer yet — cannot file");
    }
    if (!ctx.provider) return fail("provider unavailable");
    const receipt = await ctx.provider.moveConversation(
      conversation.providerConversationId,
      proposal.destinationId,
      idempotencyKey,
    );
    return {
      ok: receipt.failed.length === 0,
      replayed: false,
      processed: receipt.processed,
      failed: receipt.failed,
      error:
        receipt.failed.length > 0 ? "move failed for some messages" : undefined,
    };
  }

  if (!conversation) {
    return fail("conversation is not in Seer yet — cannot move mail");
  }

  const kind = action === "delete" ? "trash" : "archive";
  const item = await enqueueOptimistic(
    ctx.accountId,
    { type: kind, conversationId: conversation.id },
    idempotencyKey,
  );
  return {
    ok: true,
    replayed: false,
    outboxId: item.id,
    optimistic: true,
    detail: { action: kind, conversationId: conversation.id },
  };
}
