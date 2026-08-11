/**
 * Provider-neutral mail shapes. Gmail and Outlook adapters translate their
 * native payloads into exactly these types, so nothing above the adapter layer
 * knows which provider it is talking to. Business logic and UI never branch on
 * provider again.
 */

export type ProviderKind = "google" | "microsoft";

/** Folders the provider sync API exposes. Archive is corpus-only. */
export type SyncFolder = "inbox" | "sent" | "trash";

export type Address = { email: string; name?: string };

export type Attachment = {
  id: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
};

export type Message = {
  providerMessageId: string;
  from: Address;
  to: Address[];
  cc: Address[];
  sentAt: string; // ISO
  snippet: string;
  bodyHtml: string | null;
  bodyText: string | null;
  isUnread: boolean;
  isOutgoing: boolean;
  attachments: Attachment[];
};

export type Conversation = {
  providerConversationId: string;
  subject: string;
  /** Oldest first — a chief of staff reads a thread in order. */
  messages: Message[];
  lastMessageAt: string; // ISO
};

/** One page of an incremental or full sync. */
export type SyncPage = {
  conversations: Conversation[];
  deletedConversationIds: string[];
  nextCursor: string | null;
  /** Provider item estimate for the folder (messages/threads), not an exact conversation count. */
  providerTotal: number;
};

export type MutationAction = "archive" | "trash" | "restore" | "markUnread";

export type MutationReceipt = {
  conversationId: string;
  action: MutationAction;
  /** Provider message ids successfully acted on. */
  processed: string[];
  /** Provider message ids that failed — never silently dropped. */
  failed: string[];
};

export type SendReceipt = {
  providerMessageId: string;
  providerConversationId: string;
};

export type SendCommand = {
  to: Address[];
  cc?: Address[];
  bcc?: Address[];
  subject: string;
  bodyHtml: string;
};

export type ReplyCommand = {
  conversationId: string;
  /** true = reply all; recipients are derived from the thread. */
  all: boolean;
  bodyHtml: string;
};

export type ForwardCommand = {
  conversationId: string;
  to: Address[];
  bodyHtml: string;
};

export type SearchResult = {
  conversations: Conversation[];
  nextCursor: string | null;
};

/**
 * The one contract Gmail and Outlook both satisfy. Every method is
 * conversation-complete and honest about partial failure. Folder mutations are
 * state-setting: adapters ignore client idempotency keys but treat repeated
 * archive/trash/restore/markUnread as a no-op when the target state is already
 * reached or the message is gone after a prior move (404).
 */
export interface MailProvider {
  readonly kind: ProviderKind;
  sync(cursor?: string | null): Promise<SyncPage>;
  syncFolder(folder: SyncFolder, cursor?: string | null): Promise<SyncPage>;
  getConversation(id: string): Promise<Conversation>;
  search(query: string, cursor?: string | null): Promise<SearchResult>;
  send(command: SendCommand, idempotencyKey: string): Promise<SendReceipt>;
  reply(command: ReplyCommand, idempotencyKey: string): Promise<SendReceipt>;
  forward(command: ForwardCommand, idempotencyKey: string): Promise<SendReceipt>;
  mutateConversation(
    id: string,
    action: MutationAction,
    idempotencyKey: string,
  ): Promise<MutationReceipt>;
  /** Deep link to this exact conversation in the provider's web client. */
  nativeUrl(id: string): string;
}
