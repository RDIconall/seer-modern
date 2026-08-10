import { inTransaction } from "../db/transaction";
import type { AccountId } from "../db/types";
import type { MailProvider, MutationAction } from "../providers/types";
import { saveDecision } from "../intelligence/repository";
import { asConversationId } from "../db/types";
import { verifyDecisionToken } from "../view/token";
import {
  currentDeleteDecision,
  existingReceipt,
  providerConversationId,
  recordEvent,
  saveReceipt,
} from "./repository";
import type { Command, CommandResult } from "./types";

/**
 * Execute one command. Ownership and idempotency are checked first. A delete is
 * only honored when the signed token maps to the conversation's CURRENT decision
 * and that decision's home is still delete — the browser cannot delete from a
 * raw field, a stale decision, or a guessed bucket. Provider mutations report
 * partial failure; nothing is hidden.
 */

export type CommandContext = {
  accountId: AccountId;
  provider: MailProvider;
};

export async function executeCommand(
  ctx: CommandContext,
  command: Command,
  idempotencyKey: string,
): Promise<CommandResult> {
  const replay = await existingReceipt(ctx.accountId, idempotencyKey);
  if (replay) return replay;

  const result = await run(ctx, command, idempotencyKey);
  await saveReceipt(ctx.accountId, idempotencyKey, command.type, result);
  return result;
}

async function mutate(
  ctx: CommandContext,
  conversationId: string,
  action: MutationAction,
  idempotencyKey: string,
): Promise<CommandResult> {
  const providerId = await providerConversationId(ctx.accountId, conversationId);
  if (!providerId) return fail("conversation not found");
  const receipt = await ctx.provider.mutateConversation(providerId, action, idempotencyKey);
  await recordEvent(
    ctx.accountId,
    `mail_${action}`,
    { conversationId, processed: receipt.processed, failed: receipt.failed },
    idempotencyKey,
  );
  return {
    ok: receipt.failed.length === 0,
    replayed: false,
    processed: receipt.processed,
    failed: receipt.failed,
  };
}

async function run(
  ctx: CommandContext,
  command: Command,
  idempotencyKey: string,
): Promise<CommandResult> {
  switch (command.type) {
    case "delete": {
      // The token must be authentic AND still map to the current delete decision.
      const verified = verifyDecisionToken(command.deleteToken);
      if (!verified || verified.conversationId !== command.conversationId) {
        return fail("invalid delete token");
      }
      const current = await currentDeleteDecision(ctx.accountId, command.conversationId);
      if (!current) return fail("no current decision");
      if (current.decisionId !== verified.decisionId) {
        return fail("stale decision — reload and try again");
      }
      if (current.home !== "delete") {
        return fail("decision no longer authorizes delete");
      }
      return mutate(ctx, command.conversationId, "trash", idempotencyKey);
    }

    case "archive":
      return mutate(ctx, command.conversationId, "archive", idempotencyKey);
    case "restore":
      return mutate(ctx, command.conversationId, "restore", idempotencyKey);
    case "markUnread":
      return mutate(ctx, command.conversationId, "markUnread", idempotencyKey);

    case "correctConversation": {
      // A user correction is law: it supersedes the model's decision and is not
      // second-guessed by safety. Recorded as a user-sourced decision + event.
      await inTransaction(async (client) => {
        await recordEvent(
          ctx.accountId,
          "user_correction",
          { conversationId: command.conversationId, home: command.home, note: command.note ?? null },
          idempotencyKey,
          client,
        );
      });
      await saveDecision({
        accountId: ctx.accountId,
        conversationId: asConversationId(command.conversationId),
        home: command.home,
        proposedHome: command.home,
        summary: command.note ?? "",
        rationale: "Corrected by you",
        owner: "nobody",
        vetoReasons: [],
        yields: [],
        evidence: [],
        modelVersion: "user-correction",
        contextVersion: "user",
      });
      return { ok: true, replayed: false };
    }

    case "teachSender": {
      await inTransaction(async (client) => {
        await recordEvent(
          ctx.accountId,
          "user_teach_sender",
          { email: command.email.toLowerCase(), instruction: command.instruction },
          idempotencyKey,
          client,
        );
        if (command.instruction === "vip") {
          await client.query(
            `insert into seer.people (account_id, email, tier, vip, vip_source)
               values ($1, $2, 'inner', true, 'user')
               on conflict (account_id, email) do update set vip = true, vip_source = 'user'`,
            [ctx.accountId, command.email.toLowerCase()],
          );
        }
      });
      return { ok: true, replayed: false };
    }

    case "send": {
      const receipt = await ctx.provider.send(
        {
          to: command.to.map((email) => ({ email })),
          subject: command.subject,
          bodyHtml: command.bodyHtml,
        },
        idempotencyKey,
      );
      await recordEvent(
        ctx.accountId,
        "mail_send",
        { providerMessageId: receipt.providerMessageId },
        idempotencyKey,
      );
      return { ok: true, replayed: false, detail: { ...receipt } };
    }

    case "reply": {
      const receipt = await ctx.provider.reply(
        { conversationId: command.conversationId, all: command.all, bodyHtml: command.bodyHtml },
        idempotencyKey,
      );
      await recordEvent(
        ctx.accountId,
        "mail_reply",
        { conversationId: command.conversationId, providerMessageId: receipt.providerMessageId },
        idempotencyKey,
      );
      return { ok: true, replayed: false, detail: { ...receipt } };
    }

    default: {
      const _exhaustive: never = command;
      return fail(`unknown command ${JSON.stringify(_exhaustive)}`);
    }
  }
}

function fail(error: string): CommandResult {
  return { ok: false, replayed: false, error };
}
