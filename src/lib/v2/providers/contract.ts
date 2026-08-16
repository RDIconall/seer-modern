import assert from "node:assert/strict";
import type { Conversation, MailProvider, Message, SyncFolder } from "./types";

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
  /** Expected total sent-folder conversations. */
  expectedSentTotal: number;
  /** Expected total trash-folder conversations. */
  expectedTrashTotal: number;
  /** A conversation id present in sent with more than one message. */
  sentThreadId?: string;
  /** A conversation id present in trash with more than one message. */
  trashThreadId?: string;
  /**
   * Conversation whose folder-list messages span sync pages. The first inbox
   * page must still emit the fully hydrated thread (Outlook regression guard).
   */
  splitPageThreadId?: string;
  splitPageThreadMessageCount?: number;
};

const SYNC_FOLDERS: SyncFolder[] = ["inbox", "sent", "trash"];

export async function runProviderContract(
  makeHarness: () => Promise<ContractHarness>,
): Promise<void> {
  await paginatesFullMailbox(makeHarness);
  await syncFolderPaginatesEachFolder(makeHarness);
  await syncFolderHydratesSplitPageThread(makeHarness);
  await readsCompleteOrderedThread(makeHarness);
  await searchPaginates(makeHarness);
  await replyTargetsSameConversation(makeHarness);
  await mutationIsWholeThread(makeHarness);
  await mutationReportsPartialFailure(makeHarness);
  await nativeUrlTargetsConversation(makeHarness);
}

async function drainSync(provider: MailProvider): Promise<Conversation[]> {
  return drainSyncFolder(provider, "inbox");
}

async function drainSyncFolder(
  provider: MailProvider,
  folder: SyncFolder,
): Promise<Conversation[]> {
  const byId = new Map<string, Conversation>();
  let cursor: string | null = null;
  do {
    const page = await provider.syncFolder(folder, cursor);
    for (const c of page.conversations) {
      if (!byId.has(c.providerConversationId)) {
        byId.set(c.providerConversationId, c);
      }
    }
    cursor = page.nextCursor;
  } while (cursor);
  return [...byId.values()];
}

function expectedTotalForFolder(
  h: ContractHarness,
  folder: SyncFolder,
): number {
  switch (folder) {
    case "inbox":
      return h.expectedInboxTotal;
    case "sent":
      return h.expectedSentTotal;
    case "trash":
      return h.expectedTrashTotal;
  }
}

function threadIdForFolder(h: ContractHarness, folder: SyncFolder): string | undefined {
  switch (folder) {
    case "inbox":
      return h.threadId;
    case "sent":
      return h.sentThreadId;
    case "trash":
      return h.trashThreadId;
  }
}

function assertMessagesHaveBodyContent(messages: Message[], label: string): void {
  for (const m of messages) {
    const hasBody =
      (m.bodyHtml !== null && m.bodyHtml.length > 0) ||
      (m.bodyText !== null && m.bodyText.length > 0);
    assert.ok(
      hasBody,
      `${label}: message ${m.providerMessageId} must carry non-empty body content`,
    );
  }
}

function assertMessagesOldestFirst(messages: Message[], label: string): void {
  for (let i = 1; i < messages.length; i++) {
    assert.ok(
      messages[i - 1].sentAt <= messages[i].sentAt,
      `${label}: messages must be ordered oldest-first`,
    );
  }
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

async function syncFolderPaginatesEachFolder(make: () => Promise<ContractHarness>) {
  const h = await make();
  for (const folder of SYNC_FOLDERS) {
    const expected = expectedTotalForFolder(h, folder);
    const all = await drainSyncFolder(h.provider, folder);
    assert.equal(
      all.length,
      expected,
      `syncFolder(${folder}) must paginate through the entire folder`,
    );
    const firstPage = await h.provider.syncFolder(folder, null);
    assert.equal(
      firstPage.providerTotal,
      expected,
      `syncFolder(${folder}) providerTotal must reflect the whole folder`,
    );
    if (expected > 0) {
      assert.ok(
        firstPage.conversations.length >= 1,
        `syncFolder(${folder}) must return conversations`,
      );
      for (const convo of firstPage.conversations) {
        assertMessagesHaveBodyContent(
          convo.messages,
          `syncFolder(${folder}) conversation ${convo.providerConversationId}`,
        );
        assertMessagesOldestFirst(
          convo.messages,
          `syncFolder(${folder}) conversation ${convo.providerConversationId}`,
        );
      }
    }
    const threadId = threadIdForFolder(h, folder);
    if (threadId && expected > 0) {
      const convo = await h.provider.getConversation(threadId);
      assert.ok(
        convo.messages.length >= 2,
        `syncFolder(${folder}) thread must contain all its messages`,
      );
      assertMessagesHaveBodyContent(convo.messages, `getConversation(${folder})`);
      assertMessagesOldestFirst(convo.messages, `getConversation(${folder})`);
    }
  }
}

async function syncFolderHydratesSplitPageThread(make: () => Promise<ContractHarness>) {
  const h = await make();
  if (!h.splitPageThreadId || !h.splitPageThreadMessageCount) return;

  const firstPage = await h.provider.syncFolder("inbox", null);
  const matches = firstPage.conversations.filter(
    (c) => c.providerConversationId === h.splitPageThreadId,
  );
  assert.equal(
    matches.length,
    1,
    "split-page thread must be deduplicated to one conversation on the page",
  );
  const convo = matches[0];
  assert.equal(
    convo.messages.length,
    h.splitPageThreadMessageCount,
    "split-page thread must be fully hydrated on the first folder page",
  );
  assertMessagesHaveBodyContent(
    convo.messages,
    `syncFolder(inbox) split-page thread ${h.splitPageThreadId}`,
  );
  assertMessagesOldestFirst(
    convo.messages,
    `syncFolder(inbox) split-page thread ${h.splitPageThreadId}`,
  );
}

async function readsCompleteOrderedThread(make: () => Promise<ContractHarness>) {
  const h = await make();
  const convo = await h.provider.getConversation(h.threadId);
  assert.ok(convo.messages.length >= 2, "thread must contain all its messages");
  assertMessagesOldestFirst(convo.messages, "getConversation");
  assertMessagesHaveBodyContent(convo.messages, "getConversation");
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
