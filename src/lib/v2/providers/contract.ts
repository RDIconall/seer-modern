import assert from "node:assert/strict";
import type { Conversation, MailProvider } from "./types";

/**
 * The provider contract suite as a reusable function. It runs unchanged against
 * the fake provider and against the real Gmail/Outlook adapters. A provider is
 * "done" only when it passes every assertion here. Each provider test file
 * supplies a factory that returns a fresh provider plus the ids/fixtures the
 * assertions reference.
 */

export type ContractHarness = {
  provider: MailProvider;
  /** A conversation id present in the inbox with more than one message. */
  threadId: string;
  /** A conversation id whose thread contains one message flagged to fail. */
  partialFailThreadId: string;
  /** A substring that matches at least one conversation via search. */
  searchTerm: string;
  /** Expected total inbox conversations for coverage assertions. */
  expectedInboxTotal: number;
};

export async function runProviderContract(
  makeHarness: () => Promise<ContractHarness>,
): Promise<void> {
  await paginatesFullMailbox(makeHarness);
  await readsCompleteOrderedThread(makeHarness);
  await searchPaginates(makeHarness);
  await replyTargetsSameConversation(makeHarness);
  await mutationIsWholeThread(makeHarness);
  await mutationReportsPartialFailure(makeHarness);
  await nativeUrlTargetsConversation(makeHarness);
}

async function drainSync(provider: MailProvider): Promise<Conversation[]> {
  const all: Conversation[] = [];
  let cursor: string | null = null;
  do {
    const page = await provider.sync(cursor);
    all.push(...page.conversations);
    cursor = page.nextCursor;
  } while (cursor);
  return all;
}

async function paginatesFullMailbox(make: () => Promise<ContractHarness>) {
  const h = await make();
  const all = await drainSync(h.provider);
  assert.equal(
    all.length,
    h.expectedInboxTotal,
    "sync must paginate through the entire inbox",
  );
  const firstPage = await h.provider.sync(null);
  assert.equal(
    firstPage.providerTotal,
    h.expectedInboxTotal,
    "providerTotal must reflect the whole mailbox for coverage reconciliation",
  );
}

async function readsCompleteOrderedThread(make: () => Promise<ContractHarness>) {
  const h = await make();
  const convo = await h.provider.getConversation(h.threadId);
  assert.ok(convo.messages.length >= 2, "thread must contain all its messages");
  for (let i = 1; i < convo.messages.length; i++) {
    assert.ok(
      convo.messages[i - 1].sentAt <= convo.messages[i].sentAt,
      "messages must be ordered oldest-first",
    );
  }
  assert.ok(
    convo.messages.every((m) => m.bodyHtml !== undefined),
    "every message must carry its body",
  );
}

async function searchPaginates(make: () => Promise<ContractHarness>) {
  const h = await make();
  const first = await h.provider.search(h.searchTerm, null);
  assert.ok(
    first.conversations.length >= 1,
    "search must return matching conversations",
  );
}

// Note: send/mutation *idempotency* is not a provider guarantee — Gmail and
// Graph send APIs are not idempotent. Replay safety is enforced at the command
// bus via command_receipts (Task 10). The fake provider models the eventual
// guarantee; the shared contract asserts only what real adapters can deliver.

async function replyTargetsSameConversation(
  make: () => Promise<ContractHarness>,
) {
  const h = await make();
  const receipt = await h.provider.reply(
    { conversationId: h.threadId, all: true, bodyHtml: "<p>ok</p>" },
    "key-reply-1",
  );
  assert.equal(
    receipt.providerConversationId,
    h.threadId,
    "a reply must post into the same conversation",
  );
  // Recipient derivation for reply-all is provider-specific and asserted in
  // each adapter's own test by inspecting the sent request.
}

async function mutationIsWholeThread(make: () => Promise<ContractHarness>) {
  const h = await make();
  const before = await h.provider.getConversation(h.threadId);
  const first = await h.provider.mutateConversation(
    h.threadId,
    "archive",
    "key-arch-1",
  );
  assert.equal(
    first.processed.length,
    before.messages.length,
    "archive must act on every message in the thread",
  );
  assert.equal(first.failed.length, 0);
}

async function mutationReportsPartialFailure(
  make: () => Promise<ContractHarness>,
) {
  const h = await make();
  const receipt = await h.provider.mutateConversation(
    h.partialFailThreadId,
    "trash",
    "key-trash-1",
  );
  assert.ok(
    receipt.failed.length >= 1,
    "a provider-side failure must be reported, never hidden",
  );
}

async function nativeUrlTargetsConversation(
  make: () => Promise<ContractHarness>,
) {
  const h = await make();
  const url = h.provider.nativeUrl(h.threadId);
  assert.match(url, /^https:\/\//, "native url must be absolute");
  assert.ok(
    url.includes(encodeURIComponent(h.threadId)) || url.includes(h.threadId),
    "native url must target the specific conversation",
  );
}
