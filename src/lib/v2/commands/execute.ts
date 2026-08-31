import { inTransaction } from "../db/transaction";
import type { AccountId } from "../db/types";
import type { MailProvider } from "../providers/types";
import { saveDecision } from "../intelligence/repository";
import { asConversationId } from "../db/types";
import { verifyDecisionToken } from "../view/token";
import { enqueueOptimistic } from "@/lib/v3/outbox/repository";
import type { OutboxMutationKind } from "@/lib/v3/outbox/types";
import {
  completeOutboundReceipt,
  conversationBelongsToAccount,
  currentDeleteDecision,
  existingReceipt,
  isCorpusConversationId,
  recordEvent,
  reserveOutboundReceipt,
  saveReceipt,
} from "./repository";
import type { Command, CommandResult } from "./types";
import { db } from "../db/pool";
import { placeConversationOnMatter } from "../intelligence/user-matter";
import {
  saveMatterOrder,
  saveMatterOrders,
} from "@/lib/store/matter-order";
import { applyOperatingModel } from "../intelligence/operating-model";
import {
  closeLinkedMatter,
  confirmMailboxStyle,
  dismissStyleDrift,
  effectiveStyle,
  loadMailboxStyle,
  recordTrainingEvent,
  setFocusHidden,
} from "../intelligence/mailbox-style-store";
import {
  driftSignalForRelevance,
  isClearHabit,
  isIrrelevanceReason,
  isMatterBar,
  normalizeCues,
  relevanceOutcome,
} from "../intelligence/mailbox-style";

/**
 * Execute one command. Ownership and idempotency are checked first. A delete is
 * only honored when the signed token maps to the conversation's CURRENT decision
 * and that decision's home is still delete — the browser cannot delete from a
 * raw field, a stale decision, or a guessed bucket. Mail mutations (archive,
 * delete, restore, markUnread) enqueue to the write-behind outbox; send/reply/
 * forward reserve a durable receipt before any provider side effect.
 */

export type CommandContext = {
  accountId: AccountId;
  /** Queueable mutations do not need an access token or provider instance. */
  provider?: MailProvider;
};

function isOutbound(command: Command): boolean {
  return command.type === "send" || command.type === "reply" || command.type === "forward";
}

export async function executeCommand(
  ctx: CommandContext,
  command: Command,
  idempotencyKey: string,
): Promise<CommandResult> {
  const replay = await existingReceipt(ctx.accountId, idempotencyKey);
  if (replay) return replay;

  if (isOutbound(command)) {
    return executeOutbound(ctx, command, idempotencyKey);
  }

  const result = await run(ctx, command, idempotencyKey);
  await saveReceipt(ctx.accountId, idempotencyKey, command.type, result);
  return result;
}

async function executeOutbound(
  ctx: CommandContext,
  command: Command,
  idempotencyKey: string,
): Promise<CommandResult> {
  if (!ctx.provider) return fail("provider unavailable");
  const reserved = await reserveOutboundReceipt(ctx.accountId, idempotencyKey, command.type);
  if (reserved === "exists") {
    const replay = await existingReceipt(ctx.accountId, idempotencyKey);
    if (replay) return replay;
    return {
      ok: false,
      replayed: true,
      unknown: true,
      error: "outcome unknown — reconcile Sent",
    };
  }

  try {
    const result = await run(ctx, command, idempotencyKey);
    await completeOutboundReceipt(ctx.accountId, idempotencyKey, result);
    return result;
  } catch (e) {
    const failed = fail(e instanceof Error ? e.message : "outbound command failed");
    await completeOutboundReceipt(ctx.accountId, idempotencyKey, failed);
    return failed;
  }
}

async function enqueueMutation(
  ctx: CommandContext,
  type: OutboxMutationKind,
  conversationId: string,
  idempotencyKey: string,
): Promise<CommandResult> {
  try {
    const item = await enqueueOptimistic(
      ctx.accountId,
      { type, conversationId },
      idempotencyKey,
    );
    return { ok: true, replayed: false, outboxId: item.id, optimistic: true };
  } catch (e) {
    const msg = e instanceof Error ? e.message : "enqueue failed";
    if (msg === "conversation not found") return fail("conversation not found");
    throw e;
  }
}

/**
 * Ordinary reasons a conversation cannot be put on a matter.
 *
 * The mail list paints from its cache, so a row can be acted on after a sync
 * has taken the conversation out of the mailbox or someone closed the matter
 * underneath it. Those are answers to a command, not faults: thrown, they left
 * the request with no body and the client with nothing to say but a JSON
 * parser's complaint. Anything unrecognized is still a fault and still thrown.
 */
function placementRefusal(cause: unknown): CommandResult | null {
  const message = cause instanceof Error ? cause.message : "";
  switch (message) {
    case "conversation not found":
    case "conversation does not belong to account":
      return fail("conversation not found — the list was out of date");
    case "matter not found":
    case "matter does not belong to account":
    case "matter or conversation does not belong to account":
      return fail("that matter is no longer open — pick another or make a new one");
    case "matter title required":
      return fail("a new matter needs a title");
    default:
      return null;
  }
}

async function rejectCorpusId(
  ctx: CommandContext,
  providerConversationId: string,
): Promise<CommandResult | null> {
  if (await isCorpusConversationId(ctx.accountId, providerConversationId)) {
    return fail("providerConversationId must not be a corpus conversation id");
  }
  return null;
}

async function validMatterOrder(
  accountId: AccountId,
  section: string,
  requested: string[],
): Promise<string[]> {
  const candidates = [...new Set(requested)].filter((id) =>
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      id,
    ),
  );
  if (candidates.length === 0) return [];
  const rows = await db().query<{ id: string }>(
    `select id from seer.matters
      where account_id = $1
        and coalesce(function_name, 'unfiled') = $2
        and id = any($3::uuid[])`,
    [accountId, section, candidates],
  );
  const valid = new Set(rows.rows.map((row) => row.id));
  return candidates.filter((id) => valid.has(id));
}

/**
 * Persist the destination the user chose in Triage. Mailbox actions elsewhere
 * are not automatically feedback — archiving a finished matter is not the same
 * statement as correcting an email Seer just classified.
 */
async function recordTriageCorrection(
  ctx: CommandContext,
  conversationId: string,
  home: "record" | "delete",
  idempotencyKey: string,
): Promise<void> {
  await inTransaction(async (client) => {
    await recordEvent(
      ctx.accountId,
      "user_correction",
      {
        conversationId,
        home,
        source: "triage",
      },
      idempotencyKey,
      client,
    );
  });
  await saveDecision({
    accountId: ctx.accountId,
    conversationId: asConversationId(conversationId),
    home,
    proposedHome: home,
    summary:
      home === "record"
        ? "Archived by you in Triage"
        : "Deleted by you in Triage",
    rationale: "Corrected by you in Triage",
    owner: "nobody",
    vetoReasons: [],
    yields: [],
    evidence: [],
    modelVersion: "user-correction",
    contextVersion: "user",
  });
}

async function run(
  ctx: CommandContext,
  command: Command,
  idempotencyKey: string,
): Promise<CommandResult> {
  switch (command.type) {
    case "triageConversation": {
      if (
        !(await conversationBelongsToAccount(
          ctx.accountId,
          command.conversationId,
        ))
      ) {
        return fail("conversation not found");
      }
      if (command.destination === "matter") {
        await recordTrainingEvent(ctx.accountId, command.conversationId, "triage", {
          destination: "matter",
          clearToward: "leave",
          matterToward: "promote",
        });
        return run(
          ctx,
          {
            type: "correctConversation",
            conversationId: command.conversationId,
            home: "matter",
            // This note becomes the decision's summary, which is read on the
            // whiteboard and, previously, fed back into naming a matter. It has
            // to read like the sentence a person would write, as its siblings
            // in `recordTriageCorrection` do.
            note: "Filed by you in Triage",
            matterId: command.matterId,
            matterTitle: command.matterTitle,
            createMatter: command.createMatter,
          },
          idempotencyKey,
        );
      }

      const style = effectiveStyle(await loadMailboxStyle(ctx.accountId));
      if (style.clearHabit === "leave") {
        await setFocusHidden(ctx.accountId, command.conversationId, true);
        try {
          await recordTriageCorrection(
            ctx,
            command.conversationId,
            command.destination === "delete" ? "delete" : "record",
            idempotencyKey,
          );
        } catch (cause) {
          return fail(
            cause instanceof Error
              ? cause.message
              : "correction was not recorded",
          );
        }
        await recordTrainingEvent(ctx.accountId, command.conversationId, "triage", {
          destination: command.destination,
          clearToward: "leave",
          matterToward: "demote",
        });
        return { ok: true, replayed: false, detail: { focusHidden: true } };
      }

      const queued = await enqueueMutation(
        ctx,
        command.destination === "delete" ? "trash" : "archive",
        command.conversationId,
        idempotencyKey,
      );
      if (!queued.ok) return queued;

      // Provider delivery is already durable in the outbox. Feedback failing
      // must not make the UI claim the mailbox action was not queued.
      try {
        await recordTriageCorrection(
          ctx,
          command.conversationId,
          command.destination === "delete" ? "delete" : "record",
          idempotencyKey,
        );
      } catch (cause) {
        return {
          ...queued,
          detail: {
            ...(queued.detail ?? {}),
            feedbackError:
              cause instanceof Error
                ? cause.message
                : "correction was not recorded",
          },
        };
      }
      await recordTrainingEvent(ctx.accountId, command.conversationId, "triage", {
        destination: command.destination,
        clearToward: command.destination === "delete" ? "delete" : "archive",
        matterToward: "demote",
      });
      return queued;
    }

    case "delete": {
      // A person who selected this and pressed Delete has said what they want
      // done with their own mail. Ownership is the only question worth asking;
      // Seer's opinion of the conversation constrains Seer, not them.
      if (command.byUser) {
        if (!(await conversationBelongsToAccount(ctx.accountId, command.conversationId))) {
          return fail("conversation not found");
        }
        return enqueueMutation(ctx, "trash", command.conversationId, idempotencyKey);
      }

      // Otherwise this is Seer acting over a pile, and it may only reach as far
      // as the safety layer cleared: the token must be authentic AND still map
      // to the current delete decision.
      if (!command.deleteToken) return fail("delete needs clearance or a user");
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
      return enqueueMutation(ctx, "trash", command.conversationId, idempotencyKey);
    }

    case "archive":
      return enqueueMutation(ctx, "archive", command.conversationId, idempotencyKey);
    case "restore":
      return enqueueMutation(ctx, "restore", command.conversationId, idempotencyKey);
    case "markUnread":
      return enqueueMutation(ctx, "markUnread", command.conversationId, idempotencyKey);
    case "move": {
      if (!ctx.provider) return fail("provider unavailable");
      const rejected = await rejectCorpusId(ctx, command.providerConversationId);
      if (rejected) return rejected;
      const receipt = await ctx.provider.moveConversation(
        command.providerConversationId,
        command.destinationId,
        idempotencyKey,
      );
      return {
        ok: receipt.failed.length === 0,
        replayed: false,
        processed: receipt.processed,
        failed: receipt.failed,
        error:
          receipt.failed.length > 0
            ? `Could not move ${receipt.failed.length} message(s)`
            : undefined,
      };
    }

    case "reorderMatters": {
      const matterIds = await validMatterOrder(
        ctx.accountId,
        command.section,
        command.matterIds,
      );
      await saveMatterOrder(String(ctx.accountId), command.section, matterIds);
      return { ok: true, replayed: false, processed: matterIds };
    }

    case "moveMatter": {
      if (command.fromSection === command.toSection) {
        const matterIds = await validMatterOrder(
          ctx.accountId,
          command.toSection,
          command.targetMatterIds,
        );
        await saveMatterOrder(
          String(ctx.accountId),
          command.toSection,
          matterIds,
        );
        return {
          ok: true,
          replayed: false,
          processed: [command.matterId],
        };
      }
      const moved = await db().query(
        `update seer.matters
            set function_name = $3, function_source = 'user', updated_at = now()
          where id = $1 and account_id = $2`,
        [command.matterId, ctx.accountId, command.toSection],
      );
      if ((moved.rowCount ?? 0) === 0) return fail("matter not found");
      const [sourceMatterIds, targetMatterIds] = await Promise.all([
        validMatterOrder(
          ctx.accountId,
          command.fromSection,
          command.sourceMatterIds,
        ),
        validMatterOrder(
          ctx.accountId,
          command.toSection,
          command.targetMatterIds,
        ),
      ]);
      await saveMatterOrders(String(ctx.accountId), {
        [command.fromSection]: sourceMatterIds,
        [command.toSection]: targetMatterIds,
      });
      return {
        ok: true,
        replayed: false,
        processed: [command.matterId],
      };
    }

    case "correctConversation": {
      // A user correction is law: it supersedes the model's decision and is not
      // second-guessed by safety. Recorded as a user-sourced decision + event.
      if (!(await conversationBelongsToAccount(ctx.accountId, command.conversationId))) {
        return fail("conversation not found");
      }
      let matter:
        | { matterId: string; title: string }
        | undefined;
      if (command.home === "matter") {
        try {
          matter = await placeConversationOnMatter(
            ctx.accountId,
            asConversationId(command.conversationId),
            {
              matterId: command.matterId,
              matterTitle: command.matterTitle,
              createNew: command.createMatter,
            },
          );
        } catch (cause) {
          const refused = placementRefusal(cause);
          if (refused) return refused;
          throw cause;
        }
      }
      await inTransaction(async (client) => {
        await recordEvent(
          ctx.accountId,
          "user_correction",
          {
            conversationId: command.conversationId,
            home: command.home,
            note: command.note ?? null,
            matterId: matter?.matterId ?? null,
          },
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
        matterId: matter?.matterId,
        vetoReasons: [],
        yields: [],
        evidence: [],
        modelVersion: "user-correction",
        contextVersion: "user",
      });
      return {
        ok: true,
        replayed: false,
        detail: matter
          ? { matterId: matter.matterId, matterTitle: matter.title }
          : undefined,
      };
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
      if (!ctx.provider) return fail("provider unavailable");
      const receipt = await ctx.provider.send(
        {
          to: command.to.map((email) => ({ email })),
          subject: command.subject,
          bodyHtml: command.bodyHtml,
          attachments: command.attachments,
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
      if (!ctx.provider) return fail("provider unavailable");
      const rejected = await rejectCorpusId(ctx, command.providerConversationId);
      if (rejected) return rejected;
      const receipt = await ctx.provider.reply(
        {
          conversationId: command.providerConversationId,
          all: command.all,
          bodyHtml: command.bodyHtml,
        },
        idempotencyKey,
      );
      await recordEvent(
        ctx.accountId,
        "mail_reply",
        {
          conversationId: command.providerConversationId,
          providerMessageId: receipt.providerMessageId,
        },
        idempotencyKey,
      );
      return { ok: true, replayed: false, detail: { ...receipt } };
    }

    case "applyOperatingModel": {
      try {
        const state = await applyOperatingModel(ctx.accountId, {
          functions: command.functions,
          topics: command.topics,
          guidance: command.guidance,
        });
        return {
          ok: true,
          replayed: false,
          processed: state.functions,
          detail: {
            functions: state.functions,
            topics: state.topics,
            guidance: state.guidance,
          },
        };
      } catch (cause) {
        return fail(
          cause instanceof Error ? cause.message : "could not apply Atlas sections",
        );
      }
    }

    case "confirmMailboxStyle": {
      if (!isClearHabit(command.clearHabit) || !isMatterBar(command.matterBar)) {
        return fail("invalid mailbox style");
      }
      const state = await confirmMailboxStyle(ctx.accountId, {
        clearHabit: command.clearHabit,
        importanceCues: normalizeCues(command.importanceCues),
        matterBar: command.matterBar,
      });
      return {
        ok: true,
        replayed: false,
        detail: {
          clearHabit: state.clearHabit,
          importanceCues: state.importanceCues,
          matterBar: state.matterBar,
          confirmed: state.confirmed,
        },
      };
    }

    case "dismissStyleDrift": {
      await dismissStyleDrift(ctx.accountId);
      return { ok: true, replayed: false };
    }

    case "trainRelevance": {
      if (
        !(await conversationBelongsToAccount(
          ctx.accountId,
          command.conversationId,
        ))
      ) {
        return fail("conversation not found");
      }
      const reason =
        command.reason && isIrrelevanceReason(command.reason)
          ? command.reason
          : command.relevant
            ? null
            : "never_was";
      const style = effectiveStyle(await loadMailboxStyle(ctx.accountId));
      const outcome = relevanceOutcome(style, command.relevant, reason);
      const signal = driftSignalForRelevance(
        command.relevant,
        reason,
        outcome.provider,
      );
      await setFocusHidden(
        ctx.accountId,
        command.conversationId,
        outcome.focusHidden,
      );
      if (outcome.closeMatter) {
        await closeLinkedMatter(ctx.accountId, command.conversationId);
      }
      if (outcome.home === "matter") {
        const placed = await run(
          ctx,
          {
            type: "correctConversation",
            conversationId: command.conversationId,
            home: "matter",
            note: "Still relevant — kept as live work",
          },
          idempotencyKey,
        );
        await recordTrainingEvent(
          ctx.accountId,
          command.conversationId,
          "relevance",
          { relevant: true, ...signal },
        );
        return placed;
      }
      if (outcome.provider) {
        const queued = await enqueueMutation(
          ctx,
          outcome.provider === "trash" ? "trash" : "archive",
          command.conversationId,
          idempotencyKey,
        );
        if (!queued.ok) return queued;
        try {
          await recordTriageCorrection(
            ctx,
            command.conversationId,
            outcome.home,
            idempotencyKey,
          );
        } catch (cause) {
          return {
            ...queued,
            detail: {
              ...(queued.detail ?? {}),
              feedbackError:
                cause instanceof Error
                  ? cause.message
                  : "correction was not recorded",
            },
          };
        }
        await recordTrainingEvent(
          ctx.accountId,
          command.conversationId,
          "relevance",
          { relevant: false, reason, ...signal },
        );
        return queued;
      }
      try {
        await recordTriageCorrection(
          ctx,
          command.conversationId,
          outcome.home,
          idempotencyKey,
        );
      } catch (cause) {
        return fail(
          cause instanceof Error
            ? cause.message
            : "correction was not recorded",
        );
      }
      await recordTrainingEvent(
        ctx.accountId,
        command.conversationId,
        "relevance",
        { relevant: false, reason, ...signal },
      );
      return {
        ok: true,
        replayed: false,
        detail: { focusHidden: outcome.focusHidden, home: outcome.home },
      };
    }

    case "forward": {
      if (!ctx.provider) return fail("provider unavailable");
      const rejected = await rejectCorpusId(ctx, command.providerConversationId);
      if (rejected) return rejected;
      const receipt = await ctx.provider.forward(
        {
          conversationId: command.providerConversationId,
          to: command.to.map((email) => ({ email })),
          bodyHtml: command.bodyHtml,
        },
        idempotencyKey,
      );
      await recordEvent(
        ctx.accountId,
        "mail_forward",
        {
          conversationId: command.providerConversationId,
          providerMessageId: receipt.providerMessageId,
        },
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
