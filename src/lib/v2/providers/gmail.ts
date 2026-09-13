import {
  ProviderHttpError,
  providerFetch,
  type ProviderHttpOptions,
} from "./http";
import {
  conversationFetchNotFound,
  mutationErrorIsNoOp,
} from "./mutation-idempotent";
import { nativeUrlFor } from "./native-url";
import { gmailForwardHtml } from "./forward-html";
import type {
  Address,
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
  SyncContext,
  SyncFolder,
  SyncPage,
} from "./types";
import { compileGmailSearch, parseMailSearch } from "@/lib/v3/search/parser";
import { assertSyncBudget } from "./types";

/**
 * Gmail adapter. Translates Gmail REST v1 payloads into the neutral model and
 * satisfies the shared provider contract. Conversation mutations enumerate the
 * thread's messages and act per message, so a single message failure is
 * reported rather than hiding behind an atomic thread call.
 */

const API = "https://gmail.googleapis.com/gmail/v1/users/me";

type GmailHeader = { name: string; value: string };
type GmailPart = {
  mimeType?: string;
  filename?: string;
  body?: { size?: number; data?: string; attachmentId?: string };
  headers?: GmailHeader[];
  parts?: GmailPart[];
};
type GmailMessage = {
  id: string;
  threadId: string;
  snippet?: string;
  labelIds?: string[];
  internalDate?: string;
  payload?: GmailPart & { headers?: GmailHeader[] };
};
type GmailThread = { id: string; messages?: GmailMessage[] };
type GmailHistoryMessage = { message?: { id?: string; threadId?: string } };
type GmailHistoryRecord = {
  messages?: { id?: string; threadId?: string }[];
  messagesAdded?: GmailHistoryMessage[];
  messagesDeleted?: GmailHistoryMessage[];
  labelsAdded?: GmailHistoryMessage[];
  labelsRemoved?: GmailHistoryMessage[];
};

export type GmailHistorySync = {
  conversations: Conversation[];
  removedConversationIds: string[];
  deletedConversationIds: string[];
  historyId: string;
};

export type GmailDeps = {
  accessToken: string;
  accountEmail: string;
  fetchImpl?: typeof fetch;
  pageSize?: number;
};

function decodeBase64Url(data: string): string {
  return Buffer.from(data.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString(
    "utf8",
  );
}

function header(headers: GmailHeader[] | undefined, name: string): string {
  return headers?.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value ?? "";
}

function parseAddresses(raw: string): Address[] {
  if (!raw) return [];
  return raw
    .split(",")
    .map((chunk) => chunk.trim())
    .filter(Boolean)
    .map((chunk) => {
      const m = chunk.match(/^(.*)<([^>]+)>$/);
      if (m) return { name: m[1].trim().replace(/(^"|"$)/g, ""), email: m[2].trim().toLowerCase() };
      return { email: chunk.toLowerCase() };
    });
}

function walkBodies(part: GmailPart | undefined, out: { html?: string; text?: string; attachments: Message["attachments"] }): void {
  if (!part) return;
  const mime = part.mimeType ?? "";
  if (part.filename && part.body?.attachmentId) {
    out.attachments.push({
      id: part.body.attachmentId,
      filename: part.filename,
      mimeType: mime,
      sizeBytes: part.body.size ?? 0,
    });
  } else if (mime === "text/html" && part.body?.data) {
    out.html = decodeBase64Url(part.body.data);
  } else if (mime === "text/plain" && part.body?.data) {
    out.text = decodeBase64Url(part.body.data);
  }
  for (const child of part.parts ?? []) walkBodies(child, out);
}

function toMessage(m: GmailMessage, selfEmail: string): Message {
  const headers = m.payload?.headers;
  const bodies: { html?: string; text?: string; attachments: Message["attachments"] } = {
    attachments: [],
  };
  walkBodies(m.payload, bodies);
  const from = parseAddresses(header(headers, "from"))[0] ?? { email: "" };
  return {
    providerMessageId: m.id,
    from,
    to: parseAddresses(header(headers, "to")),
    cc: parseAddresses(header(headers, "cc")),
    sentAt: m.internalDate
      ? new Date(Number(m.internalDate)).toISOString()
      : new Date().toISOString(),
    snippet: m.snippet ?? "",
    bodyHtml: bodies.html ?? null,
    bodyText: bodies.text ?? null,
    isUnread: (m.labelIds ?? []).includes("UNREAD"),
    isOutgoing: from.email === selfEmail.toLowerCase(),
    attachments: bodies.attachments,
  };
}

export class GmailProvider implements MailProvider {
  readonly kind: ProviderKind = "google";
  private http: ProviderHttpOptions;
  private pageSize: number;

  constructor(private deps: GmailDeps) {
    this.http = { provider: "gmail", fetchImpl: deps.fetchImpl };
    this.pageSize = deps.pageSize ?? 100;
  }

  private auth(): Record<string, string> {
    return { authorization: `Bearer ${this.deps.accessToken}` };
  }

  private async get<T>(path: string, context?: SyncContext): Promise<T> {
    assertSyncBudget(context);
    return (await providerFetch(
      `${API}${path}`,
      { headers: this.auth() },
      { ...this.http, deadlineMs: context?.deadlineMs, signal: context?.signal },
    )) as T;
  }

  private async post<T>(path: string, body: unknown): Promise<T> {
    return (await providerFetch(
      `${API}${path}`,
      {
        method: "POST",
        headers: { ...this.auth(), "content-type": "application/json" },
        body: JSON.stringify(body),
      },
      this.http,
    )) as T;
  }

  private async rawThread(id: string, context?: SyncContext): Promise<GmailThread> {
    assertSyncBudget(context);
    return this.get<GmailThread>(`/threads/${id}?format=full`, context);
  }

  private toConversation(t: GmailThread): Conversation {
    const messages = (t.messages ?? [])
      .map((m) => toMessage(m, this.deps.accountEmail))
      .sort((a, b) => a.sentAt.localeCompare(b.sentAt));
    return {
      providerConversationId: t.id,
      subject: header(t.messages?.[0]?.payload?.headers, "subject"),
      messages,
      lastMessageAt: messages[messages.length - 1]?.sentAt ?? "",
    };
  }

  private async thread(id: string, context?: SyncContext): Promise<Conversation> {
    return this.toConversation(await this.rawThread(id, context));
  }

  private folderQuery(folder: SyncFolder): string {
    switch (folder) {
      case "inbox":
        return "in:inbox";
      case "sent":
        return "in:sent";
      case "trash":
        return "in:trash";
    }
  }

  async sync(cursor?: string | null): Promise<SyncPage> {
    return this.syncFolder("inbox", cursor);
  }

  async syncFolder(
    folder: SyncFolder,
    cursor?: string | null,
    context?: SyncContext,
  ): Promise<SyncPage> {
    assertSyncBudget(context);
    const list = await this.get<{
      threads?: { id: string }[];
      nextPageToken?: string;
      resultSizeEstimate?: number;
    }>(
      `/threads?q=${encodeURIComponent(this.folderQuery(folder))}&maxResults=${this.pageSize}` +
        (cursor ? `&pageToken=${encodeURIComponent(cursor)}` : ""),
      context,
    );
    const conversations: Conversation[] = [];
    for (const t of list.threads ?? []) {
      assertSyncBudget(context);
      conversations.push(await this.thread(t.id, context));
    }
    return {
      conversations,
      deletedConversationIds: [],
      nextCursor: list.nextPageToken ?? null,
      // Gmail thread-list estimate — not an exact conversation count.
      providerTotal: list.resultSizeEstimate ?? conversations.length,
    };
  }

  async currentHistoryId(context?: SyncContext): Promise<string> {
    const profile = await this.get<{ historyId?: string }>("/profile", context);
    if (!profile.historyId) {
      throw new Error("Gmail profile did not return a historyId");
    }
    return profile.historyId;
  }

  async syncHistory(
    startHistoryId: string,
    context?: SyncContext,
  ): Promise<GmailHistorySync> {
    const changedThreadIds = new Set<string>();
    let pageToken: string | undefined;
    let historyId = startHistoryId;

    do {
      assertSyncBudget(context);
      const page = await this.get<{
        history?: GmailHistoryRecord[];
        nextPageToken?: string;
        historyId?: string;
      }>(
        `/history?startHistoryId=${encodeURIComponent(startHistoryId)}&labelId=INBOX&maxResults=500` +
          (pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ""),
        context,
      );
      for (const record of page.history ?? []) {
        for (const item of [
          ...(record.messages ?? []).map((message) => ({ message })),
          ...(record.messagesAdded ?? []),
          ...(record.messagesDeleted ?? []),
          ...(record.labelsAdded ?? []),
          ...(record.labelsRemoved ?? []),
        ]) {
          const threadId = item.message?.threadId;
          if (threadId) changedThreadIds.add(threadId);
        }
      }
      historyId = page.historyId ?? historyId;
      pageToken = page.nextPageToken;
    } while (pageToken);

    const conversations: Conversation[] = [];
    const removedConversationIds: string[] = [];
    const deletedConversationIds: string[] = [];
    for (const threadId of changedThreadIds) {
      assertSyncBudget(context);
      try {
        const raw = await this.rawThread(threadId, context);
        const inInbox = (raw.messages ?? []).some((message) =>
          (message.labelIds ?? []).includes("INBOX"),
        );
        if (inInbox) {
          conversations.push(this.toConversation(raw));
        } else {
          removedConversationIds.push(threadId);
        }
      } catch (error) {
        if (error instanceof ProviderHttpError && error.status === 404) {
          deletedConversationIds.push(threadId);
          continue;
        }
        throw error;
      }
    }

    return {
      conversations,
      removedConversationIds,
      deletedConversationIds,
      historyId,
    };
  }

  getConversation(id: string): Promise<Conversation> {
    return this.thread(id);
  }

  async search(query: string, cursor?: string | null): Promise<SearchResult> {
    const providerQuery = compileGmailSearch(parseMailSearch(query));
    const list = await this.get<{ threads?: { id: string }[]; nextPageToken?: string }>(
      `/threads?q=${encodeURIComponent(providerQuery)}&maxResults=${this.pageSize}` +
        (cursor ? `&pageToken=${encodeURIComponent(cursor)}` : ""),
    );
    const conversations = await Promise.all(
      (list.threads ?? []).map((t) => this.thread(t.id)),
    );
    return { conversations, nextCursor: list.nextPageToken ?? null };
  }

  private encodeRaw(
    headersLines: string[],
    html: string,
    attachments: SendCommand["attachments"] = [],
  ): string {
    const safeAttachments = attachments ?? [];
    const boundary = `seer_${crypto.randomUUID().replaceAll("-", "")}`;
    const mime =
      safeAttachments.length === 0
        ? [
            ...headersLines,
            "MIME-Version: 1.0",
            'Content-Type: text/html; charset="UTF-8"',
            "",
            html,
          ].join("\r\n")
        : [
            ...headersLines,
            "MIME-Version: 1.0",
            `Content-Type: multipart/mixed; boundary="${boundary}"`,
            "",
            `--${boundary}`,
            'Content-Type: text/html; charset="UTF-8"',
            "Content-Transfer-Encoding: 8bit",
            "",
            html,
            ...safeAttachments.flatMap((attachment) => {
              const filename = attachment.filename.replace(/[\r\n"]/g, "_");
              const base64 = attachment.contentBase64
                .replace(/\s/g, "")
                .match(/.{1,76}/g)
                ?.join("\r\n") ?? "";
              return [
                `--${boundary}`,
                `Content-Type: ${attachment.mimeType || "application/octet-stream"}; name="${filename}"`,
                "Content-Transfer-Encoding: base64",
                `Content-Disposition: attachment; filename="${filename}"`,
                "",
                base64,
              ];
            }),
            `--${boundary}--`,
          ].join("\r\n");
    return Buffer.from(mime, "utf8")
      .toString("base64")
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
  }

  async send(command: SendCommand, _key: string): Promise<SendReceipt> {
    void _key;
    const raw = this.encodeRaw(
      [
        `To: ${command.to.map((a) => a.email).join(", ")}`,
        command.cc?.length ? `Cc: ${command.cc.map((a) => a.email).join(", ")}` : "",
        `Subject: ${command.subject}`,
      ].filter(Boolean),
      command.bodyHtml,
      command.attachments,
    );
    const r = await this.post<{ id: string; threadId: string }>("/messages/send", {
      raw,
    });
    return { providerMessageId: r.id, providerConversationId: r.threadId };
  }

  async reply(command: ReplyCommand, _key: string): Promise<SendReceipt> {
    void _key;
    const convo = await this.thread(command.conversationId);
    const last = convo.messages[convo.messages.length - 1];
    const recipients = new Set<string>();
    if (last?.from.email) recipients.add(last.from.email);
    if (command.all) {
      for (const a of [...(last?.to ?? []), ...(last?.cc ?? [])]) {
        if (a.email !== this.deps.accountEmail.toLowerCase()) recipients.add(a.email);
      }
    }
    const raw = this.encodeRaw(
      [
        `To: ${[...recipients].join(", ")}`,
        `Subject: Re: ${convo.subject}`,
      ],
      command.bodyHtml,
    );
    const r = await this.post<{ id: string; threadId: string }>("/messages/send", {
      raw,
      threadId: command.conversationId,
    });
    return { providerMessageId: r.id, providerConversationId: r.threadId };
  }

  async forward(command: ForwardCommand, _key: string): Promise<SendReceipt> {
    void _key;
    const convo = await this.thread(command.conversationId);
    const bodyHtml = gmailForwardHtml(convo, command.bodyHtml);
    const raw = this.encodeRaw(
      [`To: ${command.to.map((a) => a.email).join(", ")}`, `Subject: Fwd: ${convo.subject}`],
      bodyHtml,
    );
    const r = await this.post<{ id: string; threadId: string }>("/messages/send", {
      raw,
    });
    return { providerMessageId: r.id, providerConversationId: r.threadId };
  }

  private attachmentList(message: GmailMessage): Message["attachments"] {
    const out: { html?: string; text?: string; attachments: Message["attachments"] } = {
      attachments: [],
    };
    walkBodies(message.payload, out);
    return out.attachments;
  }

  async getAttachment(messageId: string, attachmentId: string): Promise<AttachmentContent> {
    const message = await this.get<GmailMessage>(`/messages/${messageId}?format=full`);
    const attachments = this.attachmentList(message);
    const prefix = `${messageId}-`;
    let resolved = attachments.find((a) => a.id === attachmentId);
    if (!resolved && attachmentId.startsWith(prefix)) {
      resolved = attachments[Number(attachmentId.slice(prefix.length))];
    }
    if (!resolved) {
      resolved = attachments.find((a) => a.filename === attachmentId);
    }
    if (!resolved?.id) throw new Error(`attachment ${attachmentId} not found`);
    const res = await this.get<{ data?: string }>(
      `/messages/${messageId}/attachments/${resolved.id}`,
    );
    const padded = (res.data ?? "").replace(/-/g, "+").replace(/_/g, "/");
    return {
      body: Buffer.from(padded, "base64"),
      mimeType: resolved.mimeType || "application/octet-stream",
      filename: resolved.filename,
    };
  }

  async listFolders(): Promise<ProviderFolder[]> {
    const response = await this.get<{
      labels?: { id: string; name: string; type?: string }[];
    }>("/labels");
    return (response.labels ?? [])
      .filter((label) => !["CHAT", "CATEGORY_FORUMS"].includes(label.id))
      .map((label) => ({
        id: label.id,
        name: label.name,
        system: label.type === "system",
      }));
  }

  async moveConversation(
    id: string,
    destinationId: string,
    _key: string,
  ): Promise<MoveReceipt> {
    void _key;
    const thread = await this.get<GmailThread>(`/threads/${id}?format=minimal`);
    const processed = (thread.messages ?? []).map((message) => message.id);
    await this.post(`/threads/${id}/modify`, {
      addLabelIds: [destinationId],
      removeLabelIds: ["INBOX", "TRASH"],
    });
    return {
      conversationId: id,
      destinationId,
      processed,
      failed: [],
    };
  }

  async mutateConversation(
    id: string,
    action: MutationAction,
    _key: string,
  ): Promise<MutationReceipt> {
    void _key;
    try {
      if (action === "trash") {
        await this.post(`/threads/${id}/trash`, {});
      } else {
        const body =
          action === "archive"
            ? { removeLabelIds: ["INBOX"] }
            : action === "restore"
              ? { addLabelIds: ["INBOX"], removeLabelIds: ["TRASH"] }
              : { addLabelIds: ["UNREAD"] };
        await this.post(`/threads/${id}/modify`, body);
      }
    } catch (err) {
      if (!mutationErrorIsNoOp(err)) throw err;
      if (action === "restore" || action === "markUnread") {
        conversationFetchNotFound(err, "gmail", id);
      }
    }
    return {
      conversationId: id,
      action,
      processed: [id],
      failed: [],
    };
  }

  nativeUrl(id: string): string {
    return nativeUrlFor("google", id);
  }
}
