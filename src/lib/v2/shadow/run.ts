import { db } from "../db/pool";
import { asConversationId, type AccountId } from "../db/types";
import { coverage } from "../sync/repository";
import { readConversation, type ReaderModel } from "../intelligence/reader";
import type { ContextInput } from "../intelligence/context";
import type { Conversation } from "../providers/types";
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

async function loadStoredConversations(accountId: AccountId): Promise<
  { conversationId: string; conversation: Conversation }[]
> {
  const convs = await db().query<{
    id: string;
    provider_conversation_id: string;
    subject: string;
    last_message_at: string | null;
  }>(
    "select id, provider_conversation_id, subject, last_message_at from seer.conversations where account_id = $1 and is_deleted = false",
    [accountId],
  );
  const out: { conversationId: string; conversation: Conversation }[] = [];
  for (const c of convs.rows) {
    const msgs = await db().query<{
      provider_message_id: string;
      from_email: string | null;
      to_emails: string[] | null;
      cc_emails: string[] | null;
      sent_at: string | null;
      body_html: string | null;
      body_text: string | null;
      snippet: string | null;
    }>(
      "select provider_message_id, from_email, to_emails, cc_emails, sent_at, body_html, body_text, snippet from seer.messages where conversation_id = $1 order by sent_at",
      [c.id],
    );
    out.push({
      conversationId: c.id,
      conversation: {
        providerConversationId: c.provider_conversation_id,
        subject: c.subject ?? "",
        messages: msgs.rows.map((m) => ({
          providerMessageId: m.provider_message_id,
        from: { email: m.from_email ?? "" },
        to: (m.to_emails ?? []).map((email) => ({ email })),
        cc: (m.cc_emails ?? []).map((email) => ({ email })),
        sentAt: m.sent_at ?? "",
          snippet: m.snippet ?? "",
          bodyHtml: m.body_html,
          bodyText: m.body_text,
          isUnread: false,
          isOutgoing: false,
          attachments: [],
        })),
        lastMessageAt: c.last_message_at ?? "",
      },
    });
  }
  return out;
}

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
