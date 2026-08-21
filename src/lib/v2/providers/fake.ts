import type {
  AttachmentContent,
  Conversation,
  ForwardCommand,
  MailProvider,
  Message,
  MutationAction,
  MutationReceipt,
  MoveReceipt,
  ProviderFolder,
  ProviderKind,
  ReplyCommand,
  SearchResult,
  SendCommand,
  SendReceipt,
  SyncFolder,
  SyncPage,
} from "./types";

/**
 * The FAKE provider is the executable reference for how every provider must
 * behave. It keeps ordered messages in memory, acts on whole conversations,
 * paginates, simulates partial failure, and deduplicates idempotency keys. The
 * contract suite runs against this and against the real Gmail/Outlook adapters
 * unchanged; when they diverge from this behavior, they are wrong.
 */

type Folder = SyncFolder | "archive";

type StoredMessage = Message & { folder: Folder; failMutation?: boolean };

type StoredConversation = {
  providerConversationId: string;
  subject: string;
  messages: StoredMessage[];
};

export type FakeSeed = {
  conversations: StoredConversation[];
  pageSize?: number;
};

export class FakeProvider implements MailProvider {
  readonly kind: ProviderKind = "google";
  private convos: StoredConversation[];
  private pageSize: number;
  private idempotency = new Map<string, SendReceipt | MutationReceipt | MoveReceipt>();
  private sentCounter = 0;

  constructor(seed: FakeSeed) {
    this.convos = seed.conversations;
    this.pageSize = seed.pageSize ?? 100;
  }

  private live(c: StoredConversation): Conversation {
    const messages = [...c.messages].sort((a, b) =>
      a.sentAt.localeCompare(b.sentAt),
    );
    return {
      providerConversationId: c.providerConversationId,
      subject: c.subject,
      messages,
      lastMessageAt: messages[messages.length - 1]?.sentAt ?? "",
    };
  }

  async sync(cursor?: string | null): Promise<SyncPage> {
    return this.syncFolder("inbox", cursor);
  }

  async syncFolder(folder: SyncFolder, cursor?: string | null): Promise<SyncPage> {
    const start = cursor ? Number(cursor) : 0;
    const folderConvos = this.convos.filter((c) =>
      c.messages.some((m) => m.folder === folder),
    );
    const slice = folderConvos.slice(start, start + this.pageSize);
    const next = start + this.pageSize;
    return {
      conversations: slice.map((c) => this.live(c)),
      deletedConversationIds:
        folder === "trash"
          ? []
          : this.convos
              .filter((c) => c.messages.every((m) => m.folder === "trash"))
              .map((c) => c.providerConversationId),
      nextCursor: next < folderConvos.length ? String(next) : null,
      providerTotal: folderConvos.length,
    };
  }

  async getConversation(id: string): Promise<Conversation> {
    const c = this.convos.find((x) => x.providerConversationId === id);
    if (!c) throw new Error(`conversation ${id} not found`);
    return this.live(c);
  }

  async listFolders(): Promise<ProviderFolder[]> {
    return [
      { id: "inbox", name: "Inbox", system: true },
      { id: "sent", name: "Sent", system: true },
      { id: "trash", name: "Trash", system: true },
      { id: "archive", name: "Archive", system: true },
    ];
  }

  async moveConversation(
    id: string,
    destinationId: string,
    key: string,
  ): Promise<MoveReceipt> {
    const existing = this.idempotency.get(key);
    if (existing && "destinationId" in existing) return existing as MoveReceipt;
    const c = this.convos.find((item) => item.providerConversationId === id);
    if (!c) throw new Error(`conversation ${id} not found`);
    const processed: string[] = [];
    const failed: string[] = [];
    for (const message of c.messages) {
      if (message.failMutation) failed.push(message.providerMessageId);
      else {
        message.folder = destinationId as Folder;
        processed.push(message.providerMessageId);
      }
    }
    const receipt = {
      conversationId: id,
      destinationId,
      processed,
      failed,
    };
    this.idempotency.set(key, receipt);
    return receipt;
  }

  async search(query: string, cursor?: string | null): Promise<SearchResult> {
    const q = query.toLowerCase();
    const matches = this.convos.filter(
      (c) =>
        c.subject.toLowerCase().includes(q) ||
        c.messages.some((m) => (m.bodyText ?? "").toLowerCase().includes(q)),
    );
    const start = cursor ? Number(cursor) : 0;
    const slice = matches.slice(start, start + this.pageSize);
    const next = start + this.pageSize;
    return {
      conversations: slice.map((c) => this.live(c)),
      nextCursor: next < matches.length ? String(next) : null,
    };
  }

  async send(command: SendCommand, key: string): Promise<SendReceipt> {
    const existing = this.idempotency.get(key);
    if (existing) return existing as SendReceipt;
    const id = `sent-${++this.sentCounter}`;
    const receipt: SendReceipt = {
      providerMessageId: id,
      providerConversationId: id,
    };
    this.convos.push({
      providerConversationId: id,
      subject: command.subject,
      messages: [
        {
          providerMessageId: id,
          from: { email: "me@example.com" },
          to: command.to,
          cc: command.cc ?? [],
          sentAt: new Date().toISOString(),
          snippet: "",
          bodyHtml: command.bodyHtml,
          bodyText: command.bodyHtml.replace(/<[^>]+>/g, ""),
          isUnread: false,
          isOutgoing: true,
          attachments: [],
          folder: "sent",
        },
      ],
    });
    this.idempotency.set(key, receipt);
    return receipt;
  }

  async reply(command: ReplyCommand, key: string): Promise<SendReceipt> {
    const existing = this.idempotency.get(key);
    if (existing) return existing as SendReceipt;
    const c = this.convos.find(
      (x) => x.providerConversationId === command.conversationId,
    );
    if (!c) throw new Error(`conversation ${command.conversationId} not found`);
    const id = `reply-${++this.sentCounter}`;
    c.messages.push({
      providerMessageId: id,
      from: { email: "me@example.com" },
      to: c.messages[0]?.to ?? [],
      cc: command.all ? (c.messages[0]?.cc ?? []) : [],
      sentAt: new Date().toISOString(),
      snippet: "",
      bodyHtml: command.bodyHtml,
      bodyText: command.bodyHtml.replace(/<[^>]+>/g, ""),
      isUnread: false,
      isOutgoing: true,
      attachments: [],
      folder: "inbox",
    });
    const receipt: SendReceipt = {
      providerMessageId: id,
      providerConversationId: c.providerConversationId,
    };
    this.idempotency.set(key, receipt);
    return receipt;
  }

  async forward(command: ForwardCommand, key: string): Promise<SendReceipt> {
    const existing = this.idempotency.get(key);
    if (existing) return existing as SendReceipt;
    const id = `fwd-${++this.sentCounter}`;
    const receipt: SendReceipt = {
      providerMessageId: id,
      providerConversationId: command.conversationId,
    };
    this.idempotency.set(key, receipt);
    return receipt;
  }

  async getAttachment(messageId: string, attachmentId: string): Promise<AttachmentContent> {
    for (const c of this.convos) {
      for (const m of c.messages) {
        if (m.providerMessageId !== messageId) continue;
        const prefix = `${messageId}-`;
        let index = m.attachments.findIndex((a) => a.id === attachmentId);
        if (index < 0 && attachmentId.startsWith(prefix)) {
          index = Number(attachmentId.slice(prefix.length));
        }
        if (index < 0) {
          index = m.attachments.findIndex((a) => a.filename === attachmentId);
        }
        const att = m.attachments[index];
        if (!att) throw new Error(`attachment ${attachmentId} not found`);
        return {
          body: Buffer.from(`fake:${att.filename}`, "utf8"),
          mimeType: att.mimeType || "application/octet-stream",
          filename: att.filename,
        };
      }
    }
    throw new Error(`message ${messageId} not found`);
  }

  async mutateConversation(
    id: string,
    action: MutationAction,
    key: string,
  ): Promise<MutationReceipt> {
    const existing = this.idempotency.get(key);
    if (existing) return existing as MutationReceipt;
    const c = this.convos.find((x) => x.providerConversationId === id);
    if (!c) throw new Error(`conversation ${id} not found`);

    const processed: string[] = [];
    const failed: string[] = [];
    // Act on EVERY message in the thread — the whole point of conversation
    // completeness. A flagged message simulates a provider-side failure.
    for (const m of c.messages) {
      if (m.failMutation) {
        failed.push(m.providerMessageId);
        continue;
      }
      m.folder =
        action === "archive"
          ? "archive"
          : action === "trash"
            ? "trash"
            : action === "restore"
              ? "inbox"
              : m.folder;
      if (action === "markUnread") m.isUnread = true;
      processed.push(m.providerMessageId);
    }
    const receipt: MutationReceipt = { conversationId: id, action, processed, failed };
    this.idempotency.set(key, receipt);
    return receipt;
  }

  nativeUrl(id: string): string {
    return `https://mail.google.com/mail/u/0/#all/${id}`;
  }
}
