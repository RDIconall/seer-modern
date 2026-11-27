import { ProviderHttpError, providerFetch, type ProviderHttpOptions } from "./http";
import {
  conversationFetchEmpty,
  conversationFetchNotFound,
  mutationErrorIsNoOp,
  outlookMutationAlreadyApplied,
} from "./mutation-idempotent";
import { nativeUrlFor } from "./native-url";
import {
  OUTLOOK_OPTIONAL_FOLDERS,
  OUTLOOK_WELL_KNOWN_FOLDERS,
  hiddenOutlookMessageIds,
  visibleOutlookMessages,
  type DeletedItemsScope,
  type OutlookFolderIds,
  type OutlookWellKnownFolder,
} from "./outlook-folders";
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
import { compileOutlookSearch, parseMailSearch } from "@/lib/v3/search/parser";
import { SyncDeadlineError, assertSyncBudget } from "./types";

/**
 * Outlook / Microsoft Graph adapter. Translates Graph message payloads into the
 * neutral model. Conversation reads and mutations gather the conversation
 * across folders (via conversationId), then keep only messages whose folder is
 * part of the mailbox Seer shows — never Junk Email, Drafts, Outbox or
 * Conversation History — so a thread is acted on completely and per-message
 * failures are reported.
 */

const API = "https://graph.microsoft.com/v1.0/me";

type GraphRecipient = { emailAddress?: { address?: string; name?: string } };
type GraphMessage = {
  id: string;
  conversationId: string;
  subject?: string;
  from?: GraphRecipient;
  toRecipients?: GraphRecipient[];
  ccRecipients?: GraphRecipient[];
  receivedDateTime?: string;
  bodyPreview?: string;
  body?: { contentType?: string; content?: string };
  isRead?: boolean;
  hasAttachments?: boolean;
  parentFolderId?: string;
  attachments?: { id?: string; name?: string; contentType?: string; size?: number }[];
};

export type OutlookDeps = {
  accessToken: string;
  accountEmail: string;
  fetchImpl?: typeof fetch;
  pageSize?: number;
};

function addr(r: GraphRecipient | undefined): Address | null {
  const email = r?.emailAddress?.address?.toLowerCase();
  if (!email) return null;
  return { email, name: r?.emailAddress?.name };
}

function addrs(list: GraphRecipient[] | undefined): Address[] {
  return (list ?? []).map(addr).filter((a): a is Address => a !== null);
}

function toMessage(m: GraphMessage, selfEmail: string): Message {
  const isHtml = (m.body?.contentType ?? "").toLowerCase() === "html";
  const from = addr(m.from) ?? { email: "" };
  return {
    providerMessageId: m.id,
    from,
    to: addrs(m.toRecipients),
    cc: addrs(m.ccRecipients),
    sentAt: m.receivedDateTime ?? new Date().toISOString(),
    snippet: m.bodyPreview ?? "",
    bodyHtml: isHtml ? (m.body?.content ?? null) : null,
    bodyText: isHtml ? null : (m.body?.content ?? null),
    isUnread: m.isRead === false,
    isOutgoing: from.email === selfEmail.toLowerCase(),
    attachments: (m.attachments ?? []).map((a) => ({
      id: a.id ?? "",
      filename: a.name ?? "",
      mimeType: a.contentType ?? "",
      sizeBytes: a.size ?? 0,
    })),
  };
}

function newestFirst(a: GraphMessage, b: GraphMessage): number {
  return (b.receivedDateTime ?? "").localeCompare(a.receivedDateTime ?? "");
}

export class OutlookProvider implements MailProvider {
  readonly kind: ProviderKind = "microsoft";
  private http: ProviderHttpOptions;
  private pageSize: number;
  /** Well-known folder ids, resolved once per provider and reused for every filter. */
  private folderIdCache = new Map<OutlookWellKnownFolder, Promise<string | null>>();

  constructor(private deps: OutlookDeps) {
    this.http = { provider: "outlook", fetchImpl: deps.fetchImpl };
    this.pageSize = deps.pageSize ?? 50;
  }

  private auth(): Record<string, string> {
    return { authorization: `Bearer ${this.deps.accessToken}` };
  }

  private async get<T>(url: string, context?: SyncContext): Promise<T> {
    assertSyncBudget(context);
    return (await providerFetch(
      url,
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

  private async patch(path: string, body: unknown): Promise<void> {
    await providerFetch(
      `${API}${path}`,
      {
        method: "PATCH",
        headers: { ...this.auth(), "content-type": "application/json" },
        body: JSON.stringify(body),
      },
      this.http,
    );
  }

  /**
   * Every message in a conversation, across all folders, paginated. Unfiltered:
   * callers must pass the result through `visible` before showing or acting on it.
   */
  private async conversationMessages(
    conversationId: string,
    context?: SyncContext,
  ): Promise<GraphMessage[]> {
    const messages: GraphMessage[] = [];
    let url: string | null =
      `${API}/messages?$filter=${encodeURIComponent(
        `conversationId eq '${conversationId.replace(/'/g, "''")}'`,
      )}&$top=50&$select=id,conversationId,subject,from,toRecipients,ccRecipients,receivedDateTime,bodyPreview,body,isRead,hasAttachments,parentFolderId` +
      // Metadata only — never the file bytes.
      `&$expand=attachments($select=id,name,contentType,size)`;
    while (url) {
      assertSyncBudget(context);
      const page: { value?: GraphMessage[]; "@odata.nextLink"?: string } =
        await this.get(url, context);
      messages.push(...(page.value ?? []));
      url = page["@odata.nextLink"] ?? null;
    }
    return messages;
  }

  private folderId(
    name: OutlookWellKnownFolder,
    context?: SyncContext,
  ): Promise<string | null> {
    const cached = this.folderIdCache.get(name);
    if (cached) return cached;
    const lookup = this.get<{ id?: string }>(
      `${API}/mailFolders/${name}?$select=id`,
      context,
    ).then(
      (folder) => {
        if (!folder?.id) throw new Error(`outlook folder ${name} has no id`);
        return folder.id;
      },
      (err: unknown) => {
        // A mailbox without this well-known folder has no messages in it.
        if (
          OUTLOOK_OPTIONAL_FOLDERS.has(name) &&
          err instanceof ProviderHttpError &&
          err.status === 404
        ) {
          return null;
        }
        throw err;
      },
    );
    this.folderIdCache.set(name, lookup);
    lookup.catch(() => {
      if (this.folderIdCache.get(name) === lookup) this.folderIdCache.delete(name);
    });
    return lookup;
  }

  private async folderIds(context?: SyncContext): Promise<OutlookFolderIds> {
    const ids = await Promise.all(
      OUTLOOK_WELL_KNOWN_FOLDERS.map((name) => this.folderId(name, context)),
    );
    return Object.fromEntries(
      OUTLOOK_WELL_KNOWN_FOLDERS.map((name, i) => [name, ids[i]]),
    ) as OutlookFolderIds;
  }

  /** Messages of an already-fetched conversation that belong to the thread Seer shows. */
  private async visible(
    messages: GraphMessage[],
    deletedItems: DeletedItemsScope,
    context?: SyncContext,
  ): Promise<{ messages: GraphMessage[]; folders: OutlookFolderIds }> {
    const folders = await this.folderIds(context);
    return {
      messages: visibleOutlookMessages(messages, folders, deletedItems),
      folders,
    };
  }

  private async replyTarget(conversationId: string): Promise<GraphMessage> {
    const { messages } = await this.visible(
      await this.conversationMessages(conversationId),
      "whenOnlyDeleted",
    );
    const last = [...messages].sort(newestFirst)[0];
    if (!last) throw new Error(`outlook conversation ${conversationId} has no messages`);
    return last;
  }

  private toConversation(id: string, msgs: GraphMessage[]): Conversation {
    const messages = msgs
      .map((m) => toMessage(m, this.deps.accountEmail))
      .sort((a, b) => a.sentAt.localeCompare(b.sentAt));
    return {
      providerConversationId: id,
      subject: msgs[0]?.subject ?? "",
      messages,
      lastMessageAt: messages[messages.length - 1]?.sentAt ?? "",
    };
  }

  private folderPath(folder: SyncFolder): string {
    switch (folder) {
      case "inbox":
        return "inbox";
      case "sent":
        return "sentitems";
      case "trash":
        return "deleteditems";
    }
  }

  /** Graph folder message-item estimate — not an exact conversation count. */
  private async folderTotal(folder: SyncFolder, context?: SyncContext): Promise<number> {
    try {
      const r: { totalItemCount?: number } = await this.get(
        `${API}/mailFolders/${this.folderPath(folder)}?$select=totalItemCount`,
        context,
      );
      return r.totalItemCount ?? 0;
    } catch (error) {
      if (error instanceof SyncDeadlineError) throw error;
      return 0;
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
    const url =
      cursor ??
      `${API}/mailFolders/${this.folderPath(folder)}/messages?$top=${this.pageSize}&$select=id,conversationId,subject,from,toRecipients,ccRecipients,receivedDateTime,bodyPreview,isRead,hasAttachments&$orderby=receivedDateTime desc`;
    const page: {
      value?: GraphMessage[];
      "@odata.nextLink"?: string;
      "@odata.count"?: number;
    } = await this.get(url, context);
    // Deduplicate conversation ids while preserving first-seen order on this page.
    const conversationIds = [
      ...new Set((page.value ?? []).map((m) => m.conversationId)),
    ];
    const deletedItems: DeletedItemsScope = folder === "trash" ? "include" : "exclude";
    const conversations: Conversation[] = [];
    for (const id of conversationIds) {
      assertSyncBudget(context);
      const all = await this.conversationMessages(id, context);
      const { messages, folders } = await this.visible(all, deletedItems, context);
      if (messages.length === 0) continue;
      conversations.push({
        ...this.toConversation(id, messages),
        withheldMessageIds: hiddenOutlookMessageIds(all, folders),
      });
    }
    return {
      conversations,
      deletedConversationIds: [],
      nextCursor: page["@odata.nextLink"] ?? null,
      // Graph counts folder messages, not conversations — an item estimate only.
      providerTotal:
        page["@odata.count"] ?? (await this.folderTotal(folder, context)),
    };
  }

  async getConversation(id: string): Promise<Conversation> {
    const { messages } = await this.visible(
      await this.conversationMessages(id),
      "whenOnlyDeleted",
    );
    return this.toConversation(id, messages);
  }

  async search(query: string, cursor?: string | null): Promise<SearchResult> {
    const providerQuery = compileOutlookSearch(parseMailSearch(query));
    const url =
      cursor ??
      `${API}/messages?$search=${encodeURIComponent(`"${providerQuery}"`)}&$top=${this.pageSize}&$select=id,conversationId,subject,from,toRecipients,ccRecipients,receivedDateTime,bodyPreview,body,isRead,parentFolderId`;
    const page: { value?: GraphMessage[]; "@odata.nextLink"?: string } =
      await this.get(url);
    const byConversation = new Map<string, GraphMessage[]>();
    for (const m of page.value ?? []) {
      const arr = byConversation.get(m.conversationId) ?? [];
      arr.push(m);
      byConversation.set(m.conversationId, arr);
    }
    const folders = await this.folderIds();
    const conversations: Conversation[] = [];
    for (const [id, msgs] of byConversation) {
      const shown = visibleOutlookMessages(msgs, folders, "whenOnlyDeleted");
      if (shown.length > 0) conversations.push(this.toConversation(id, shown));
    }
    return {
      conversations,
      nextCursor: page["@odata.nextLink"] ?? null,
    };
  }

  async send(command: SendCommand, _key: string): Promise<SendReceipt> {
    void _key;
    await this.post("/sendMail", {
      message: {
        subject: command.subject,
        body: { contentType: "HTML", content: command.bodyHtml },
        toRecipients: command.to.map((a) => ({ emailAddress: { address: a.email } })),
        ccRecipients: (command.cc ?? []).map((a) => ({
          emailAddress: { address: a.email },
        })),
        attachments: (command.attachments ?? []).map((attachment) => ({
          "@odata.type": "#microsoft.graph.fileAttachment",
          name: attachment.filename,
          contentType: attachment.mimeType,
          contentBytes: attachment.contentBase64,
        })),
      },
    });
    // Graph sendMail returns 202 with no id; the sent item surfaces on next sync.
    return { providerMessageId: "sent", providerConversationId: "sent" };
  }

  async reply(command: ReplyCommand, _key: string): Promise<SendReceipt> {
    void _key;
    const last = await this.replyTarget(command.conversationId);
    const endpoint = command.all ? "replyAll" : "reply";
    await this.post(`/messages/${last.id}/${endpoint}`, {
      comment: command.bodyHtml,
    });
    return {
      providerMessageId: "sent",
      providerConversationId: command.conversationId,
    };
  }

  async forward(command: ForwardCommand, _key: string): Promise<SendReceipt> {
    void _key;
    const last = await this.replyTarget(command.conversationId);
    await this.post(`/messages/${last.id}/forward`, {
      comment: command.bodyHtml,
      toRecipients: command.to.map((a) => ({ emailAddress: { address: a.email } })),
    });
    return {
      providerMessageId: "sent",
      providerConversationId: command.conversationId,
    };
  }

  async getAttachment(messageId: string, attachmentId: string): Promise<AttachmentContent> {
    const message = await this.get<GraphMessage>(
      `${API}/messages/${messageId}?$select=id&$expand=attachments($select=id,name,contentType,size)`,
    );
    const attachments = message.attachments ?? [];
    const prefix = `${messageId}-`;
    let resolved = attachments.find((a) => a.id === attachmentId);
    if (!resolved && attachmentId.startsWith(prefix)) {
      resolved = attachments[Number(attachmentId.slice(prefix.length))];
    }
    if (!resolved) {
      resolved = attachments.find((a) => a.name === attachmentId);
    }
    if (!resolved?.id) throw new Error(`attachment ${attachmentId} not found`);

    const doFetch = this.deps.fetchImpl ?? fetch;
    const res = await doFetch(
      `${API}/messages/${messageId}/attachments/${resolved.id}/$value`,
      { headers: this.auth(), cache: "no-store" },
    );
    if (!res.ok) {
      throw new Error(`outlook attachment: ${res.status}`);
    }
    return {
      body: Buffer.from(await res.arrayBuffer()),
      mimeType: resolved.contentType ?? "application/octet-stream",
      filename: resolved.name ?? "attachment",
    };
  }

  async listFolders(): Promise<ProviderFolder[]> {
    const response = await this.get<{
      value?: { id: string; displayName: string; wellKnownName?: string }[];
    }>(`${API}/mailFolders?$top=100&$select=id,displayName`);
    return (response.value ?? []).map((folder) => ({
      id: folder.id,
      name: folder.displayName,
      system: ["Inbox", "Sent Items", "Deleted Items", "Archive"].includes(
        folder.displayName,
      ),
    }));
  }

  async moveConversation(
    id: string,
    destinationId: string,
    _key: string,
  ): Promise<MoveReceipt> {
    void _key;
    const { messages } = await this.visible(
      await this.conversationMessages(id),
      "whenOnlyDeleted",
    );
    const processed: string[] = [];
    const failed: string[] = [];
    for (const message of messages) {
      try {
        await this.post(`/messages/${message.id}/move`, { destinationId });
        processed.push(message.id);
      } catch {
        failed.push(message.id);
      }
    }
    return { conversationId: id, destinationId, processed, failed };
  }

  async mutateConversation(
    id: string,
    action: MutationAction,
    _key: string,
  ): Promise<MutationReceipt> {
    void _key;
    let msgs: GraphMessage[];
    try {
      msgs = await this.conversationMessages(id);
    } catch (err) {
      conversationFetchNotFound(err, "outlook", id);
    }
    conversationFetchEmpty(msgs, "outlook", id);
    const { messages, folders } = await this.visible(msgs, "whenOnlyDeleted");
    conversationFetchEmpty(messages, "outlook", id);
    const processed: string[] = [];
    const failed: string[] = [];
    for (const m of messages) {
      if (outlookMutationAlreadyApplied(action, m.parentFolderId, folders)) {
        processed.push(m.id);
        continue;
      }
      try {
        if (action === "archive") {
          await this.post(`/messages/${m.id}/move`, { destinationId: "archive" });
        } else if (action === "trash") {
          await this.post(`/messages/${m.id}/move`, { destinationId: "deleteditems" });
        } else if (action === "restore") {
          await this.post(`/messages/${m.id}/move`, { destinationId: "inbox" });
        } else {
          await this.patch(`/messages/${m.id}`, { isRead: false });
        }
        processed.push(m.id);
      } catch (err) {
        if (mutationErrorIsNoOp(err)) {
          processed.push(m.id);
        } else {
          failed.push(m.id);
        }
      }
    }
    return { conversationId: id, action, processed, failed };
  }

  nativeUrl(id: string): string {
    return nativeUrlFor("microsoft", id);
  }
}
