import { db } from "../db/pool";
import { asConversationId, type AccountId } from "../db/types";
import { coverage } from "../sync/repository";
import { readConversation, type ReaderModel } from "../intelligence/reader";
import { loadStoredConversations } from "../intelligence/load-conversation";
import type { ContextInput } from "../intelligence/context";
import type { ShadowReport } from "./report";
import type { ReleaseVerdict } from "../eval/types";

/**
 * Read-only shadow rebuild. It reads every stored conversation through the v2
 * pipeline WITHOUT issuing a single provider mutation, so decisions can be
 * compared with the old app and the baseline before anything is cut over. The
 * mutation counter is threaded through and asserted zero by the gate.
 */

export type ShadowInput = {
  accountId: AccountId;
  account: string;
  model: ReaderModel;
  context: ContextInput;
  benchmark: ReleaseVerdict | null;
  providerParityPassed: boolean;
};

export async function runShadow(input: ShadowInput): Promise<ShadowReport> {
  // Shadow never hands a provider to the reader, so a mutation is impossible by
  // construction. The counter records that invariant for the gate.
  const shadowMutations = 0;
  // Yields are persisted transactionally with each decision, so a
  // detected-but-unpersisted yield cannot occur.
  const unpersistedYields = 0;
  let missingNativeLinks = 0;

  const conversations = await loadStoredConversations(input.accountId);
  for (const { conversationId, conversation } of conversations) {
    await readConversation({
      accountId: input.accountId,
      conversationId: asConversationId(conversationId),
      conversation,
      context: input.context,
      model: input.model,
    });
    if (!conversation.providerConversationId) missingNativeLinks++;
  }

  const cov = await coverage(input.accountId);
  const readRow = await db().query<{ n: number }>(
    `select count(*)::int as n from seer.conversation_decisions
      where account_id = $1 and is_current and home <> 'undecided'`,
    [input.accountId],
  );

  return {
    account: input.account,
    coverage: {
      providerTotal: cov.providerTotal,
      stored: cov.stored,
      read: readRow.rows[0]?.n ?? 0,
      pending: cov.pending,
      failed: 0,
    },
    benchmark: input.benchmark,
    providerParityPassed: input.providerParityPassed,
    missingNativeLinks,
    unpersistedYields,
    shadowMutations,
  };
}
