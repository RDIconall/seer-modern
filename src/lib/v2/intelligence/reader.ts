import type { AccountId, ConversationId } from "../db/types";
import type { Conversation } from "../providers/types";
import { compileContext, type ContextInput } from "./context";
import { saveDecision } from "./repository";
import { validateDelete, type SafetyFacts } from "./safety";
import {
  CONTEXT_VERSION,
  MODEL_VERSION,
  readResultSchema,
  type ConversationDecision,
  type ReadResult,
} from "./schema";

/**
 * The chief-of-staff read. One conversation in, one persisted decision out. The
 * model call is injected so the pipeline is testable without a live LLM and so
 * there is exactly one model invocation per conversation — no snippet grader,
 * no keyword fallback. If the read cannot be completed, the conversation lands
 * `undecided`; it is never guessed into a home.
 */

export type ReaderModel = (input: {
  conversation: Conversation;
  contextText: string;
}) => Promise<ReadResult>;

export type ReadInput = {
  accountId: AccountId;
  conversationId: ConversationId;
  conversation: Conversation;
  context: ContextInput;
  model: ReaderModel;
};

function hasCompleteContent(conversation: Conversation): boolean {
  if (conversation.messages.length === 0) return false;
  return conversation.messages.every(
    (m) => (m.bodyHtml && m.bodyHtml.length > 0) || (m.bodyText && m.bodyText.length > 0),
  );
}

function factsFrom(
  read: ReadResult,
  compiled: { senderIsKnown: boolean; senderIsInternal: boolean; candidateMatterId: string | null },
  hadCompleteContext: boolean,
): SafetyFacts {
  const openAsk = Boolean(read.ask && !/^\s*nothing/i.test(read.ask));
  return {
    ownerIsYou: read.owner === "you",
    hasOpenAsk: openAsk,
    hasPendingObligation: read.obligation,
    liveMatterId: compiled.candidateMatterId,
    senderIsKnown: compiled.senderIsKnown,
    senderIsInternal: compiled.senderIsInternal,
    // Yields are persisted transactionally with the decision below, so at the
    // moment of saving they are guaranteed present.
    yieldPersisted: true,
    hadCompleteContext,
  };
}

export async function readConversation(
  input: ReadInput,
): Promise<ConversationDecision> {
  const compiled = compileContext(input.conversation, input.context);

  // A read requires the full thread. Without it, stay honest: undecided.
  if (!hasCompleteContent(input.conversation)) {
    return saveDecision({
      accountId: input.accountId,
      conversationId: input.conversationId,
      home: "undecided",
      proposedHome: "undecided",
      summary: "",
      rationale: "Not read yet — incomplete conversation content",
      owner: "nobody",
      vetoReasons: ["incomplete_context"],
      yields: [],
      evidence: compiled.refs.map((ref) => ({ ref, provenance: "observed" as const })),
    });
  }

  let read: ReadResult;
  try {
    const raw = await input.model({
      conversation: input.conversation,
      contextText: compiled.text,
    });
    read = readResultSchema.parse(raw);
  } catch {
    // Model, timeout, or parse failure → undecided and retryable. Never a guess.
    return saveDecision({
      accountId: input.accountId,
      conversationId: input.conversationId,
      home: "undecided",
      proposedHome: "undecided",
      summary: "",
      rationale: "Not read yet — model unavailable",
      owner: "nobody",
      vetoReasons: ["read_failed"],
      yields: [],
      evidence: [],
    });
  }

  const facts = factsFrom(read, compiled, true);
  const safety = validateDelete(read, facts);

  return saveDecision({
    accountId: input.accountId,
    conversationId: input.conversationId,
    home: safety.home,
    proposedHome: read.home,
    summary: read.summary,
    rationale: read.rationale,
    owner: read.owner,
    ask: read.ask,
    matterId: compiled.candidateMatterId,
    vetoReasons: safety.vetoReasons,
    yields: read.yields,
    evidence: read.evidence.length
      ? read.evidence
      : compiled.refs.map((ref) => ({ ref, provenance: "inference" as const })),
    modelVersion: MODEL_VERSION,
    contextVersion: CONTEXT_VERSION,
  });
}
