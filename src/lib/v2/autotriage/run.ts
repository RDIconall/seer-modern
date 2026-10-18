import type { MailAccount } from "../db/accounts";
import { asAccountId, type AccountId } from "../db/types";
import { recordEvent } from "../commands/repository";
import { enqueueOptimistic } from "@/lib/v3/outbox/repository";
import { insertProposal } from "../staff/repository";
import { aiAutoAction, classifyUnknownSender } from "./ai";
import { loadAutoTriageContext } from "./context";
import {
  ensureSettings,
  getWatermark,
  findLogByMessage,
  insertLog,
  listInboxCandidates,
  pendingProposalExists,
  setAutoTriageMode,
  setWatermark,
  type CandidateMessage,
} from "./repository";
import { classify, domainOf, isAutomated } from "./rules";
import type {
  AutoTriageAction,
  AutoTriageAiCaller,
  AutoTriageMode,
  ClassifyResult,
  CompiledRules,
} from "./types";

export const CIRCUIT_BREAKER_DELETE_LIMIT = 50;
const SAVE_DOC_DESTINATION = "Files to Save (save PDF to Drive first)";

export function envAutoTriageMode(
  env: NodeJS.ProcessEnv = process.env,
): AutoTriageMode {
  const raw = (env.SEER_AUTOTRIAGE ?? "dry_run").trim().toLowerCase();
  if (raw === "off" || raw === "dry_run" || raw === "live") return raw;
  return "dry_run";
}

export function effectiveAutoTriageMode(
  envMode: AutoTriageMode,
  dbMode: AutoTriageMode,
): AutoTriageMode {
  if (envMode === "off" || dbMode === "off") return "off";
  if (envMode === "live" && dbMode === "live") return "live";
  return "dry_run";
}

export function proposalsEnabled(
  mode: AutoTriageMode,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (mode === "live") return true;
  return env.SEER_AUTOTRIAGE_PROPOSALS === "1";
}

function proposalAction(
  action: AutoTriageAction,
  proposed: AutoTriageAction,
): "delete" | "archive" | "keep" | "file" | "filtered" {
  const value = action === "review" || action === "unknown" ? proposed : action;
  if (value === "save-doc") return "file";
  if (value === "delete") return "delete";
  if (value === "archive") return "archive";
  if (value === "keep") return "keep";
  return "keep";
}

function applyOpenThread(
  result: ClassifyResult,
  open: boolean,
): ClassifyResult {
  if (!open) return result;
  if (result.action !== "delete" && result.action !== "archive" && result.action !== "unknown") {
    return result;
  }
  return {
    ...result,
    action: "review",
    proposed: result.proposed === "unknown" ? "keep" : result.proposed,
    reason: `${result.reason} [open thread: keep/review]`,
    protected: result.protected ?? "open_thread",
  };
}

function applyAiGuards(
  result: ClassifyResult,
  autoAction: "delete" | "archive",
  reason: string,
  automated: boolean,
  rules: CompiledRules,
  domain: string,
): ClassifyResult {
  if (result.corresponded && !automated) {
    return {
      action: "review",
      proposed: autoAction,
      rule: result.rule,
      reason: `${reason} [protected: corresponded; sent to Seer instead]`,
      protected: "corresponded",
      corresponded: true,
    };
  }
  const humanAllow =
    !automated &&
    (rules.allowlistDomains.has(domain) || rules.repliedDomains.has(domain));
  if (humanAllow) {
    return {
      action: "review",
      proposed: autoAction,
      rule: result.rule,
      reason: `${reason} [protected: human_at_allowlisted_domain; sent to Seer instead]`,
      protected: "human_at_allowlisted_domain",
      corresponded: result.corresponded,
    };
  }
  if (rules.freemail.has(domain) && !automated) {
    return {
      action: "review",
      proposed: autoAction,
      rule: result.rule,
      reason: `${reason} [protected: freemail_human; sent to Seer instead]`,
      protected: "freemail_human",
      corresponded: result.corresponded,
    };
  }
  return {
    action: autoAction,
    proposed: autoAction,
    rule: `ai:${result.rule}`,
    reason,
    protected: null,
    corresponded: result.corresponded,
  };
}

export type AutoTriageTickReport = {
  email: string;
  mode: AutoTriageMode;
  considered: number;
  logged: number;
  deleted: number;
  archived: number;
  proposals: number;
  skipped: number;
  circuitBreaker?: boolean;
};

export async function autotriageAccount(
  account: MailAccount,
  conversationIds: string[] = [],
  deps: { aiCaller?: AutoTriageAiCaller } = {},
): Promise<AutoTriageTickReport> {
  const accountId = asAccountId(account.id);
  const envMode = envAutoTriageMode();
  const empty: AutoTriageTickReport = {
    email: account.email,
    mode: envMode,
    considered: 0,
    logged: 0,
    deleted: 0,
    archived: 0,
    proposals: 0,
    skipped: 0,
  };
  if (envMode === "off") return { ...empty, mode: "off" };

  const settings = await ensureSettings(accountId);
  let mode = effectiveAutoTriageMode(envMode, settings.mode);
  if (mode === "off") return { ...empty, mode: "off" };

  const watermark = await getWatermark(accountId);
  const candidates = await listInboxCandidates(accountId, conversationIds, watermark);
  if (candidates.length === 0) {
    if (!watermark) await setWatermark(accountId, new Date().toISOString());
    return { ...empty, mode };
  }

  const ctx = await loadAutoTriageContext(accountId);
  const judged: Array<{
    candidate: CandidateMessage;
    result: ClassifyResult;
    decider: "rule" | "ai";
    aiConfidence: number | null;
  }> = [];

  for (const candidate of candidates) {
    let result = classify(
      {
        addr: candidate.senderEmail,
        subject: candidate.subject,
        conversationId: candidate.conversationId,
        receivedAt: candidate.sentAt,
      },
      ctx,
      ctx.rules,
    );
    let decider: "rule" | "ai" = "rule";
    let aiConfidence: number | null = null;

    if (result.action === "unknown" && settings.aiEnabled) {
      const ai = await classifyUnknownSender({
        accountId,
        sender: candidate.senderEmail,
        subject: candidate.subject,
        snippet: candidate.snippet,
        caller: deps.aiCaller,
      });
      if (ai) {
        decider = "ai";
        aiConfidence = ai.confidence;
        const auto = aiAutoAction(ai, settings.aiAutoThreshold);
        if (auto) {
          const automated = isAutomated(candidate.senderEmail, ctx.rules.automatedLocal);
          result = applyAiGuards(
            result,
            auto,
            `AI ${ai.category} (${ai.confidence}): ${ai.reason}`,
            automated,
            ctx.rules,
            domainOf(candidate.senderEmail),
          );
        } else {
          result = {
            ...result,
            action: "review",
            proposed: result.proposed,
            reason: `AI ${ai.category} (${ai.confidence}): ${ai.reason}`,
          };
        }
      } else {
        result = {
          ...result,
          action: "review",
          proposed: result.proposed,
          reason: `${result.reason} [AI unavailable or over budget]`,
        };
      }
    }

    result = applyOpenThread(result, ctx.openThreads.has(candidate.conversationId));
    judged.push({ candidate, result, decider, aiConfidence });
  }

  const wouldDelete = judged.filter((row) => row.result.action === "delete").length;
  let circuitBreaker = false;
  if (wouldDelete > CIRCUIT_BREAKER_DELETE_LIMIT) {
    circuitBreaker = true;
    mode = "dry_run";
    await setAutoTriageMode(accountId, "dry_run");
    await recordEvent(
      accountId,
      "autotriage_circuit_breaker",
      { wouldDelete, limit: CIRCUIT_BREAKER_DELETE_LIMIT },
      `autotriage-breaker:${accountId}:${Date.now()}`,
    );
  }

  const allowProposals = proposalsEnabled(mode);
  const report: AutoTriageTickReport = {
    email: account.email,
    mode,
    considered: judged.length,
    logged: 0,
    deleted: 0,
    archived: 0,
    proposals: 0,
    skipped: 0,
    circuitBreaker: circuitBreaker || undefined,
  };

  let maxSent: string | null = watermark ? watermark.toISOString() : null;

  for (const row of judged) {
    const applied = await applyDecision(accountId, row.candidate, row.result, {
      mode,
      decider: row.decider,
      aiConfidence: row.aiConfidence,
      allowProposals,
    });
    if (applied.logged) report.logged += 1;
    else report.skipped += 1;
    if (applied.deleted) report.deleted += 1;
    if (applied.archived) report.archived += 1;
    if (applied.proposal) report.proposals += 1;
    if (row.candidate.sentAt && (!maxSent || row.candidate.sentAt > maxSent)) {
      maxSent = row.candidate.sentAt;
    }
  }

  if (maxSent) await setWatermark(accountId, maxSent);
  return report;
}

async function applyDecision(
  accountId: AccountId,
  candidate: CandidateMessage,
  result: ClassifyResult,
  opts: {
    mode: AutoTriageMode;
    decider: "rule" | "ai";
    aiConfidence: number | null;
    allowProposals: boolean;
  },
): Promise<{ logged: boolean; deleted: boolean; archived: boolean; proposal: boolean }> {
  const existing = await findLogByMessage(accountId, candidate.providerMessageId);
  if (existing) {
    return { logged: false, deleted: false, archived: false, proposal: false };
  }
  let outboxId: string | null = null;
  let proposalId: string | null = null;
  let deleted = false;
  let archived = false;
  let proposal = false;

  const live = opts.mode === "live";
  const wantsMove = result.action === "delete" || result.action === "archive";
  if (live && wantsMove) {
    const item = await enqueueOptimistic(
      accountId,
      {
        type: result.action === "delete" ? "trash" : "archive",
        conversationId: candidate.conversationId,
      },
      `autotriage:${candidate.providerMessageId}`,
    );
    outboxId = item.id;
    if (result.action === "delete") deleted = true;
    else archived = true;
  }

  const wantsProposal =
    result.action === "review" ||
    result.action === "unknown" ||
    result.action === "save-doc";
  if (opts.allowProposals && wantsProposal) {
    const exists = await pendingProposalExists(accountId, candidate.conversationId);
    if (!exists) {
      const created = await insertProposal({
        accountId,
        conversationId: candidate.conversationId,
        providerConversationId: candidate.providerConversationId,
        senderEmail: candidate.senderEmail,
        subject: candidate.subject,
        action: proposalAction(result.action, result.proposed),
        destinationName:
          result.action === "save-doc" ? SAVE_DOC_DESTINATION : null,
        rationale: `${result.reason} [${result.rule}]`,
      });
      proposalId = created.id;
      proposal = true;
    }
  }

  const logged = await insertLog({
    accountId,
    conversationId: candidate.conversationId,
    providerMessageId: candidate.providerMessageId,
    senderEmail: candidate.senderEmail,
    subject: candidate.subject,
    action: result.action,
    proposed: result.proposed,
    rule: result.rule,
    reason: result.reason,
    decider: opts.decider,
    aiConfidence: opts.aiConfidence,
    mode: opts.mode,
    outboxId,
    proposalId,
  });

  return {
    logged: Boolean(logged),
    deleted,
    archived,
    proposal,
  };
}
