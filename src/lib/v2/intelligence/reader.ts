import type { AccountId, ConversationId } from "../db/types";
import type { Conversation } from "../providers/types";
import { compileContext, type ContextInput } from "./context";
import { counterpartyOf, matterNameFrom } from "./matter-key";
import {
  ensureMatter,
  findMatterByRef,
  linkConversationToMatter,
  saveDecision,
} from "./repository";
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

  // Promotion: live work must land on the board. Reuse the matched matter, or
  // create one from the read's proposed name — otherwise a `matter` decision
  // has no matter to belong to and would be misfiled.
  let matterId = compiled.candidateMatterId;
  if (safety.home === "matter") {
    // Tie on what this is ABOUT: codes in the subject/name/body plus the
    // counterparty. Sender type is irrelevant — an automated portal notice
    // about an event belongs to that event's unit of work.
    const tieText = [
      input.conversation.subject,
      read.matterRef ?? "",
      read.summary,
      input.conversation.messages[0]?.bodyText?.slice(0, 400) ?? "",
    ].join(" ");
    const counterparty = counterpartyOf(
      input.conversation.messages[input.conversation.messages.length - 1]?.from.email ?? "",
      input.context.ownDomain,
    );
    matterId = await ensureMatter(
      input.accountId,
      matterNameFrom(read.matterRef, input.conversation.subject, counterparty, tieText),
      { text: tieText, counterparty },
    );
    await linkConversationToMatter(matterId, input.conversationId);
  }

  // Attach extracted meaning to the matter it names, so a development lands on
  // the concern it belongs to — including when the conversation itself is
  // disposable (a newsletter that touches a live matter keeps its insight).
  const resolvedYields = await Promise.all(
    read.yields.map(async (y) => {
      if (y.kind !== "matter_connection") return y;
      const ref = y.matterRef?.trim();
      if (!ref) return { ...y, matterId: matterId ?? null };
      const found = await findMatterByRef(input.accountId, ref);
      return { ...y, matterId: found ?? matterId ?? null };
    }),
  );

  return saveDecision({
    accountId: input.accountId,
    conversationId: input.conversationId,
    home: safety.home,
    proposedHome: read.home,
    summary: read.summary,
    rationale: read.rationale,
    owner: read.owner,
    ask: read.ask,
    matterId,
    vetoReasons: safety.vetoReasons,
    yields: resolvedYields,
    evidence: read.evidence.length
      ? read.evidence
      : compiled.refs.map((ref) => ({ ref, provenance: "inference" as const })),
    modelVersion: MODEL_VERSION,
    contextVersion: CONTEXT_VERSION,
  });
}
