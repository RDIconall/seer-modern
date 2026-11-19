import { generateText, Output } from "ai";
import type { Conversation } from "../providers/types";
import {
  modelReadResultSchema,
  normalizeModelReadResult,
  type ReadResult,
} from "./schema";
import { readableBody } from "./html-text";
import type {
  ReaderModel,
  ReaderModelInput,
} from "./reader";
import {
  recordModelUsage,
  withinDailyBudget,
  type ModelUsageRecord,
} from "./model-usage";

/**
 * The real chief-of-staff model, behind the injectable ReaderModel interface.
 * One structured call per conversation over the WHOLE thread plus the context
 * packet. There is no snippet path and no keyword fallback. The output schema
 * permits exactly three homes; if both model routes fail, no classification is
 * persisted and the queue retries the conversation later.
 */

export const CHIEF_OF_STAFF_SYSTEM = `You are a chief of staff reading one email conversation for a busy executive.

Decide two things and nothing else:

1. HOME — where this conversation belongs:
   - "matter": live work with a counterparty that must be tracked (a real ask of the user, a negotiation, a decision they owe, a signature/approval/regulatory/legal/payment step, or someone waiting on their reply). An automated notification, reminder, trial/billing notice, product announcement, or status update is NOT a matter no matter how urgent it sounds — being time-sensitive is not the same as being unresolved work with a counterparty. When you choose "matter" you MUST set matterRef.

   NAMING matterRef — name THE WORK, the way its own one-line status would start:
   - counterparty or person + the specific deliverable, decision or process: "Roche anti-TPO pricing", "Rubrum Advising consulting contract", "Lucianne Hill EA recruiting". Include a study/event code when one exists.
   - NEVER name it after the user or the user's own company. Every matter on this desk involves them, so their names identify nothing. Name the OTHER side and the work.
   - NEVER name the fact that people are in contact. "Engagement", "call", "catch-up", "follow-up", "outreach", "intro" are how work happens, not what it is. If a call is being scheduled, name whose call and what about ("Dirk Weiss call scheduling"), never "<company> engagement / <user> call".
   - Never the email's subject line verbatim, and never an imperative.
   - "record": no live story, but worth keeping (receipt, executed contract, invoice, statement, confirmation).
   - "delete": the useful meaning (if any) has been captured in YIELDS and the email itself is not needed.
   Judge from MEANING, never the sender's shape. A no-reply address can carry an approval; a real person can send pure noise.

2. YIELDS — business meaning worth keeping even if the email is deleted:
   - "matter_connection": the body touches a live matter, client, prospect, competitor, or person in the user's world. Set matterRef to the matter it touches. ONLY when the CONTEXT names such a matter/person — never invent one.
   - "worth_reading": an article/report the user is likely to want, and ONLY when it matches an interest the CONTEXT states.
   - "fact"/"contact": a concrete fact or new contact worth retaining.
   Surface nothing generic. No connection without evidence in the context.

Set obligation=true when a signature, approval, regulatory, legal, or payment step is still outstanding for the user. Set owner to who must act next. Set ask to the specific thing wanted, or "nothing — informational".

Set dueDate ONLY when the email states a real date by which something must happen or a window closes ("respond by August 30", "expires August 19", "renews on 07/11/2026", "bidding closes Friday"). Use YYYY-MM-DD. Never infer or guess a date, and never use the date the email was sent. Leave it out when the email states none.

Distinguish a GENERIC BROADCAST from a DIRECT DEMAND. A sourcing/procurement notice sent to every vendor ("open for bidding", "event opens in 1 hour", "response time revised"), a portal digest, or an automated status update is ambient — owner is usually "nobody" or "them". But the SAME channel can carry a message addressed to the user by name, quoting them, or explicitly asking them to respond, decide, approve, or sign — especially from a senior or named counterparty contact. That is owner "you" with a real ask. Judge from the recipients (is the user in To, or is this a broadcast?) and the body (is the user personally being asked?), never from the sender's address alone.

Use the CONTEXT block as sourced evidence: [explicit]/[system] outrank your reading; [inference] is a hint. Absence of relationship is itself evidence toward fyi/disposable — but a real ask, signature, or deadline in the body always wins.`;

/**
 * Anyone who can email a connected mailbox controls these fields, and every
 * character is billed as input on each paid call. A message body is cut at
 * MESSAGE_BODY_CHAR_BUDGET; all bodies in one prompt share
 * THREAD_BODY_CHAR_BUDGET, newest message first, so the latest turn is never
 * the one dropped.
 */
export const MESSAGE_BODY_CHAR_BUDGET = 8_000;
export const THREAD_BODY_CHAR_BUDGET = 32_000;
export const MESSAGES_PER_READ = 20;
const SUBJECT_CHAR_BUDGET = 500;
const ADDRESS_CHAR_BUDGET = 200;
const RECIPIENTS_PER_FIELD = 10;
const ATTACHMENTS_PER_MESSAGE = 10;
const FILENAME_CHAR_BUDGET = 120;
const CONTEXT_CHAR_BUDGET = 4_000;
/** Serialized prompt ceiling. A prompt still above it is never submitted. */
export const READ_PROMPT_CHAR_CEILING = 96_000;
const TRUNCATION_MARKER = "\n[… truncated]";

export class OversizedReadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OversizedReadError";
  }
}

/** Cut to at most `budget` UTF-16 units without splitting a surrogate pair. */
function clip(text: string, budget: number): string {
  if (text.length <= budget) return text;
  if (budget <= 0) return "";
  const marker = budget > TRUNCATION_MARKER.length ? TRUNCATION_MARKER : "";
  let end = budget - marker.length;
  const last = text.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end--;
  return text.slice(0, end) + marker;
}

/** "Raiane Sousa Gaspar <raiane@roche.com>" — what a paste would show. */
function addressLine(a: { email: string; name?: string }): string {
  const line = a.name && a.name !== a.email ? `${a.name} <${a.email}>` : a.email;
  return clip(line, ADDRESS_CHAR_BUDGET);
}

function addressList(list: { email: string; name?: string }[]): string[] {
  const shown = list.slice(0, RECIPIENTS_PER_FIELD).map(addressLine);
  const hidden = list.length - shown.length;
  return hidden > 0 ? [...shown, `… and ${hidden} more`] : shown;
}

export function conversationPayload(
  conversation: Conversation,
  limits: { bodyBudget?: number; maxMessages?: number } = {},
) {
  const maxMessages = Math.max(1, limits.maxMessages ?? MESSAGES_PER_READ);
  let remaining = Math.min(
    limits.bodyBudget ?? THREAD_BODY_CHAR_BUDGET,
    THREAD_BODY_CHAR_BUDGET,
  );
  const all = conversation.messages;
  const kept: { message: (typeof all)[number]; body: string }[] = [];
  for (let i = all.length - 1; i >= 0 && kept.length < maxMessages; i--) {
    if (kept.length > 0 && remaining <= 0) break;
    const body = clip(
      readableBody(all[i]),
      Math.min(MESSAGE_BODY_CHAR_BUDGET, Math.max(0, remaining)),
    );
    remaining -= body.length;
    kept.unshift({ message: all[i], body });
  }
  const omitted = all.length - kept.length;
  return {
    subject: clip(conversation.subject, SUBJECT_CHAR_BUDGET),
    ...(omitted > 0 ? { omittedEarlierMessages: omitted } : {}),
    messages: kept.map(({ message: m, body }) => ({
      // Names matter: seniority and identity live in them, not the address.
      from: addressLine(m.from),
      to: addressList(m.to),
      cc: addressList(m.cc),
      sentAt: m.sentAt,
      ...(m.attachments.length
        ? {
            attachments: m.attachments
              .slice(0, ATTACHMENTS_PER_MESSAGE)
              .map((a) => clip(a.filename, FILENAME_CHAR_BUDGET)),
          }
        : {}),
      body,
    })),
  };
}

/**
 * The exact prompt text submitted for one read. JSON escaping can inflate the
 * clipped fields, so the serialized form is measured and the thread is shrunk
 * until it fits; if it still cannot fit, the read is refused before any paid
 * call.
 */
export function readPrompt(input: ReaderModelInput): string {
  const context = clip(
    input.contextText || "no prior relationship on record",
    CONTEXT_CHAR_BUDGET,
  );
  let bodyBudget = THREAD_BODY_CHAR_BUDGET;
  let maxMessages = MESSAGES_PER_READ;
  for (let attempt = 0; attempt < 8; attempt++) {
    const prompt = JSON.stringify({
      context,
      conversation: conversationPayload(input.conversation, {
        bodyBudget,
        maxMessages,
      }),
    });
    if (prompt.length <= READ_PROMPT_CHAR_CEILING) return prompt;
    bodyBudget = Math.floor(bodyBudget / 2);
    maxMessages = Math.max(1, Math.floor(maxMessages / 2));
  }
  throw new OversizedReadError(
    `conversation exceeds the ${READ_PROMPT_CHAR_CEILING}-character read prompt ceiling`,
  );
}

/**
 * Current Gateway model IDs (verified against its public model catalog).
 *
 * Fast: GA Gemini 3.1 Flash Lite — $0.25/M input, $1.50/M output, 1M context.
 * Strong: Claude Sonnet 4.6 — adaptive thinking, 1M context. The strong model
 * is an initial configuration, NOT a claim that Anthropic wins our bake-off;
 * changing it is an environment variable, not a code change.
 */
const DEFAULT_FAST_MODEL = "google/gemini-3.1-flash-lite";
const DEFAULT_STRONG_MODEL = "anthropic/claude-sonnet-4.6";
const DEFAULT_STRONG_FALLBACKS = [
  "openai/gpt-5.4",
  "google/gemini-3.1-pro-preview",
];

export type RoutedTier = "fast" | "strong";

export type ModelCallResult = {
  output: ReadResult;
  usage: {
    inputTokens?: number;
    outputTokens?: number;
    reasoningTokens?: number;
    cachedInputTokens?: number;
    totalTokens?: number;
  };
  providerMetadata?: Record<string, unknown>;
  latencyMs: number;
};

export type ModelCaller = (
  model: string,
  tier: RoutedTier,
  input: ReaderModelInput,
  prompt: string,
) => Promise<ModelCallResult>;

export type UsageRecorder = (
  record: ModelUsageRecord,
) => Promise<void>;

function envList(name: string, fallback: string[]): string[] {
  const value = process.env[name]?.trim();
  if (!value) return fallback;
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function requestedModel(tier: RoutedTier): string {
  return tier === "fast"
    ? process.env.SEER_ROUTER_FAST_MODEL?.trim() || DEFAULT_FAST_MODEL
    : process.env.SEER_ROUTER_STRONG_MODEL?.trim() || DEFAULT_STRONG_MODEL;
}

function fallbackModels(tier: RoutedTier): string[] {
  return tier === "fast"
    ? envList("SEER_ROUTER_FAST_FALLBACKS", [])
    : envList("SEER_ROUTER_STRONG_FALLBACKS", DEFAULT_STRONG_FALLBACKS);
}

/**
 * Consequence-driven escalation. This is deterministic and inspectable — no
 * hidden "router model" spends tokens deciding which model gets tokens.
 */
export function escalationReasons(
  read: ReadResult,
  input: ReaderModelInput,
): string[] {
  const reasons: string[] = [];
  // Matter creation and matter connections affect the board's structure, so a
  // stronger model verifies them before they become durable.
  if (read.home === "matter") reasons.push("proposed_matter");
  if (read.yields.some((y) => y.kind === "matter_connection")) {
    reasons.push("matter_connection");
  }
  if (input.routingFacts.liveMatterId) reasons.push("live_matter");

  // A delete with ANY protective signal gets reviewed. Easy, unprotected
  // disposable mail stays on the fast result.
  if (read.home === "delete") {
    if (input.routingFacts.senderIsKnown) reasons.push("delete_known_sender");
    if (input.routingFacts.senderIsInternal) reasons.push("delete_internal_sender");
    // Being in To is not enough: most mass mail addresses the user directly.
    // "Direct message to me" is evidenced by owner/ask/obligation or a known
    // relationship below, not by the envelope alone.
    if (read.owner === "you") reasons.push("delete_owner_you");
    if (read.obligation) reasons.push("delete_obligation");
    if (read.ask && !/^\s*nothing/i.test(read.ask)) {
      reasons.push("delete_open_ask");
    }
  }
  return [...new Set(reasons)];
}

/**
 * One Gateway call with model-level fallbacks. AI SDK retries are disabled:
 * Gateway provider/model fallbacks are visible in generation metadata and do
 * not create opaque duplicate attempts in app code.
 */
export const callGatewayModel: ModelCaller = async (
  model,
  tier,
  _input,
  prompt,
) => {
  if (prompt.length > READ_PROMPT_CHAR_CEILING) {
    throw new OversizedReadError("read prompt exceeds the submission ceiling");
  }
  const started = Date.now();
  const result = await generateText({
    // A provider/model string routes through Vercel AI Gateway (OIDC in Vercel,
    // AI_GATEWAY_API_KEY outside it).
    model,
    temperature: 0,
    maxRetries: 0,
    abortSignal: AbortSignal.timeout(60_000),
    output: Output.object({ schema: modelReadResultSchema }),
    providerOptions: {
      gateway: {
        models: fallbackModels(tier),
        caching: "auto",
        // Fast work chooses the cheapest healthy provider; strong work keeps
        // the configured model but can fail over across its providers/models.
        ...(tier === "fast" ? { sort: "cost" } : {}),
      },
      google: {
        thinkingConfig: {
          thinkingLevel: tier === "fast" ? "minimal" : "medium",
          includeThoughts: false,
        },
      },
      anthropic: {
        effort: tier === "strong" ? "medium" : "low",
        thinking: { type: "adaptive" },
      },
    },
    system: CHIEF_OF_STAFF_SYSTEM,
    prompt,
  });
  return {
    output: normalizeModelReadResult(result.output),
    usage: {
      inputTokens: result.usage.inputTokens,
      outputTokens: result.usage.outputTokens,
      reasoningTokens: result.usage.outputTokenDetails.reasoningTokens,
      cachedInputTokens: result.usage.inputTokenDetails.cacheReadTokens,
      totalTokens: result.usage.totalTokens,
    },
    providerMetadata: result.providerMetadata as
      | Record<string, unknown>
      | undefined,
    latencyMs: Date.now() - started,
  };
};

function gatewayMetadata(
  metadata: Record<string, unknown> | undefined,
): Record<string, unknown> {
  const gateway = metadata?.gateway;
  return gateway && typeof gateway === "object"
    ? (gateway as Record<string, unknown>)
    : {};
}

async function persistUsage(
  recorder: UsageRecorder,
  input: ReaderModelInput,
  tier: RoutedTier,
  model: string,
  reasons: string[],
  result: ModelCallResult,
): Promise<void> {
  const gateway = gatewayMetadata(result.providerMetadata);
  const rawCost = gateway.cost;
  const cost =
    typeof rawCost === "number"
      ? rawCost
      : typeof rawCost === "string"
        ? Number(rawCost)
        : undefined;
  try {
    await recorder({
      accountId: input.accountId,
      conversationId: input.conversationId,
      tier,
      model,
      escalationReasons: reasons,
      latencyMs: result.latencyMs,
      inputTokens: result.usage.inputTokens,
      outputTokens: result.usage.outputTokens,
      reasoningTokens: result.usage.reasoningTokens,
      cachedInputTokens: result.usage.cachedInputTokens,
      totalTokens: result.usage.totalTokens,
      gatewayGenerationId:
        typeof gateway.generationId === "string"
          ? gateway.generationId
          : undefined,
      costUsd: Number.isFinite(cost) ? cost : undefined,
      providerMetadata: result.providerMetadata,
    });
  } catch (error) {
    // Telemetry is essential for operations, but a transient telemetry write
    // must not discard a good read and cause a second paid call.
    console.error(
      "[seer:v2] model usage persistence failed:",
      error instanceof Error ? error.message : error,
    );
  }
}

export function createReaderRouter(deps: {
  call?: ModelCaller;
  recordUsage?: UsageRecorder;
  allowCall?: (
    accountId: ReaderModelInput["accountId"],
    tier: RoutedTier,
  ) => Promise<boolean>;
} = {}): ReaderModel {
  const call = deps.call ?? callGatewayModel;
  const recorder = deps.recordUsage ?? recordModelUsage;
  const allowCall = deps.allowCall ?? withinDailyBudget;

  return async (input) => {
    // Built once and reused for both tiers: an oversized thread is refused
    // here, before either paid call, and the strong retry cannot carry more
    // than the fast call did.
    const prompt = readPrompt(input);
    const fastModel = requestedModel("fast");
    let fast: ModelCallResult;
    try {
      if (!(await allowCall(input.accountId, "fast"))) {
        throw new Error("fast daily model-call limit reached");
      }
      fast = await call(fastModel, "fast", input, prompt);
      await persistUsage(recorder, input, "fast", fastModel, [], fast);
    } catch (fastError) {
      // A fast-model outage is itself an escalation reason. The strong route
      // may still serve the read through a different provider.
      const reasons = ["fast_failed"];
      const strongModel = requestedModel("strong");
      if (!(await allowCall(input.accountId, "strong"))) throw fastError;
      const strong = await call(strongModel, "strong", input, prompt);
      await persistUsage(
        recorder,
        input,
        "strong",
        strongModel,
        reasons,
        strong,
      );
      return strong.output;
    }

    const reasons = escalationReasons(fast.output, input);
    if (reasons.length === 0) return fast.output;

    const strongModel = requestedModel("strong");
    if (!(await allowCall(input.accountId, "strong"))) {
      // The fast model already made one of the three valid classifications.
      // Strong verification is preferred for consequential cases, but budget
      // exhaustion must not invent a fourth answer.
      return {
        ...fast.output,
        rationale: `${fast.output.rationale} (fast classification; strong verification budget reached: ${reasons.join(", ")})`,
      };
    }
    const strong = await call(strongModel, "strong", input, prompt);
    await persistUsage(
      recorder,
      input,
      "strong",
      strongModel,
      reasons,
      strong,
    );
    return strong.output;
  };
}

export const defaultReaderModel: ReaderModel = createReaderRouter();
