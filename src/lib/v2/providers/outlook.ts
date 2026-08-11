import { providerFetch, type ProviderHttpOptions } from "./http";
import { nativeUrlFor } from "./native-url";
import type {
  Address,
  Conversation,
  ForwardCommand,
  MailProvider,
  Message,
  MutationAction,
  MutationReceipt,
  ProviderKind,
  ReplyCommand,
  SearchResult,
  SendCommand,
  SendReceipt,
  SyncFolder,
  SyncPage,
} from "./types";

/**
 * Outlook / Microsoft Graph adapter. Translates Graph message payloads into the
 * neutral model. Conversation reads and mutations gather every message in the
 * conversation across folders (via conversationId), so a thread is acted on
 * completely and per-message failures are reported.
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

export class OutlookProvider implements MailProvider {
  readonly kind: ProviderKind = "microsoft";
  private http: ProviderHttpOptions;
  private pageSize: number;

  constructor(private deps: OutlookDeps) {
    this.http = { provider: "outlook", fetchImpl: deps.fetchImpl };
    this.pageSize = deps.pageSize ?? 50;
  }

  private auth(): Record<string, string> {
    return { authorization: `Bearer ${this.deps.accessToken}` };
  }

  private async get<T>(url: string): Promise<T> {
    return (await providerFetch(url, { headers: this.auth() }, this.http)) as T;
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

  /** Every message in a conversation, across all folders, paginated. */
  private async conversationMessages(conversationId: string): Promise<GraphMessage[]> {
    const messages: GraphMessage[] = [];
    let url: string | null =
      `${API}/messages?$filter=${encodeURIComponent(
        `conversationId eq '${conversationId.replace(/'/g, "''")}'`,
      )}&$top=50&$select=id,conversationId,subject,from,toRecipients,ccRecipients,receivedDateTime,bodyPreview,body,isRead,hasAttachments,parentFolderId` +
      // Metadata only — never the file bytes.
      `&$expand=attachments($select=id,name,contentType,size)`;
    while (url) {
      const page: { value?: GraphMessage[]; "@odata.nextLink"?: string } =
        await this.get(url);
      messages.push(...(page.value ?? []));
      url = page["@odata.nextLink"] ?? null;
    }
    return messages;
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

  /** The provider's own folder message count, for coverage reconciliation. */
  private async folderTotal(folder: SyncFolder): Promise<number> {
    try {
      const r: { totalItemCount?: number } = await this.get(
        `${API}/mailFolders/${this.folderPath(folder)}?$select=totalItemCount`,
      );
      return r.totalItemCount ?? 0;
    } catch {
      return 0;
    }
  }

  async sync(cursor?: string | null): Promise<SyncPage> {
    return this.syncFolder("inbox", cursor);
  }

  async syncFolder(folder: SyncFolder, cursor?: string | null): Promise<SyncPage> {
    const url =
      cursor ??
      `${API}/mailFolders/${this.folderPath(folder)}/messages?$top=${this.pageSize}&$select=id,conversationId,subject,from,toRecipients,ccRecipients,receivedDateTime,bodyPreview,body,isRead,hasAttachments&$expand=attachments($select=id,name,contentType,size)&$orderby=receivedDateTime desc`;
    const page: {
      value?: GraphMessage[];
      "@odata.nextLink"?: string;
      "@odata.count"?: number;
    } = await this.get(url);
    const byConversation = new Map<string, GraphMessage[]>();
    for (const m of page.value ?? []) {
      const arr = byConversation.get(m.conversationId) ?? [];
      arr.push(m);
      byConversation.set(m.conversationId, arr);
    }
    const conversations = [...byConversation.entries()].map(([id, msgs]) =>
      this.toConversation(id, msgs),
    );
    return {
      conversations,
      deletedConversationIds: [],
      nextCursor: page["@odata.nextLink"] ?? null,
      providerTotal: page["@odata.count"] ?? (await this.folderTotal(folder)),
    };
  }

  async getConversation(id: string): Promise<Conversation> {
    return this.toConversation(id, await this.conversationMessages(id));
  }

  async search(query: string, cursor?: string | null): Promise<SearchResult> {
    const url =
      cursor ??
      `${API}/messages?$search=${encodeURIComponent(`"${query}"`)}&$top=${this.pageSize}&$select=id,conversationId,subject,from,toRecipients,ccRecipients,receivedDateTime,bodyPreview,body,isRead`;
    const page: { value?: GraphMessage[]; "@odata.nextLink"?: string } =
      await this.get(url);
    const byConversation = new Map<string, GraphMessage[]>();
    for (const m of page.value ?? []) {
      const arr = byConversation.get(m.conversationId) ?? [];
      arr.push(m);
      byConversation.set(m.conversationId, arr);
    }
    return {
      conversations: [...byConversation.entries()].map(([id, msgs]) =>
        this.toConversation(id, msgs),
      ),
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
      },
    });
    // Graph sendMail returns 202 with no id; the sent item surfaces on next sync.
    return { providerMessageId: "sent", providerConversationId: "sent" };
  }

  async reply(command: ReplyCommand, _key: string): Promise<SendReceipt> {
    void _key;
    const msgs = await this.conversationMessages(command.conversationId);
    const last = msgs[msgs.length - 1];
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
    const msgs = await this.conversationMessages(command.conversationId);
    const last = msgs[msgs.length - 1];
    await this.post(`/messages/${last.id}/forward`, {
      comment: command.bodyHtml,
      toRecipients: command.to.map((a) => ({ emailAddress: { address: a.email } })),
    });
    return {
      providerMessageId: "sent",
      providerConversationId: command.conversationId,
    };
  }

  async mutateConversation(
    id: string,
    action: MutationAction,
    _key: string,
  ): Promise<MutationReceipt> {
    void _key;
    const msgs = await this.conversationMessages(id);
    const processed: string[] = [];
    const failed: string[] = [];
    for (const m of msgs) {
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
      } catch {
        failed.push(m.id);
      }
    }
    return { conversationId: id, action, processed, failed };
  }

  nativeUrl(id: string): string {
    return nativeUrlFor("microsoft", id);
  }
}
