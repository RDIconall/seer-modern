import { providerFetch, type ProviderHttpOptions } from "./http";
import {
  gmailMutationAlreadyApplied,
  mutationErrorIsNoOp,
} from "./mutation-idempotent";
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

  private async get<T>(path: string): Promise<T> {
    return (await providerFetch(`${API}${path}`, { headers: this.auth() }, this.http)) as T;
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

  private async thread(id: string): Promise<Conversation> {
    const t = await this.get<GmailThread>(`/threads/${id}?format=full`);
    const messages = (t.messages ?? [])
      .map((m) => toMessage(m, this.deps.accountEmail))
      .sort((a, b) => a.sentAt.localeCompare(b.sentAt));
    return {
      providerConversationId: id,
      subject: header(t.messages?.[0]?.payload?.headers, "subject"),
      messages,
      lastMessageAt: messages[messages.length - 1]?.sentAt ?? "",
    };
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

  async syncFolder(folder: SyncFolder, cursor?: string | null): Promise<SyncPage> {
    const list = await this.get<{
      threads?: { id: string }[];
      nextPageToken?: string;
      resultSizeEstimate?: number;
    }>(
      `/threads?q=${encodeURIComponent(this.folderQuery(folder))}&maxResults=${this.pageSize}` +
        (cursor ? `&pageToken=${encodeURIComponent(cursor)}` : ""),
    );
    const conversations = await Promise.all(
      (list.threads ?? []).map((t) => this.thread(t.id)),
    );
    return {
      conversations,
      deletedConversationIds: [],
      nextCursor: list.nextPageToken ?? null,
      // Gmail thread-list estimate — not an exact conversation count.
      providerTotal: list.resultSizeEstimate ?? conversations.length,
    };
  }

  getConversation(id: string): Promise<Conversation> {
    return this.thread(id);
  }

  async search(query: string, cursor?: string | null): Promise<SearchResult> {
    const list = await this.get<{ threads?: { id: string }[]; nextPageToken?: string }>(
      `/threads?q=${encodeURIComponent(query)}&maxResults=${this.pageSize}` +
        (cursor ? `&pageToken=${encodeURIComponent(cursor)}` : ""),
    );
    const conversations = await Promise.all(
      (list.threads ?? []).map((t) => this.thread(t.id)),
    );
    return { conversations, nextCursor: list.nextPageToken ?? null };
  }

  private encodeRaw(headersLines: string[], html: string): string {
    const mime = [
      ...headersLines,
      "MIME-Version: 1.0",
      'Content-Type: text/html; charset="UTF-8"',
      "",
      html,
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
    const raw = this.encodeRaw(
      [`To: ${command.to.map((a) => a.email).join(", ")}`, `Subject: Fwd: ${convo.subject}`],
      command.bodyHtml,
    );
    const r = await this.post<{ id: string; threadId: string }>("/messages/send", {
      raw,
    });
    return { providerMessageId: r.id, providerConversationId: r.threadId };
  }

  async mutateConversation(
    id: string,
    action: MutationAction,
    _key: string,
  ): Promise<MutationReceipt> {
    void _key;
    let raw: GmailThread;
    try {
      raw = await this.get<GmailThread>(`/threads/${id}?format=full`);
    } catch (err) {
      if (mutationErrorIsNoOp(err)) {
        return { conversationId: id, action, processed: [], failed: [] };
      }
      throw err;
    }
    const processed: string[] = [];
    const failed: string[] = [];
    const body =
      action === "archive"
        ? { removeLabelIds: ["INBOX"] }
        : action === "restore"
          ? { addLabelIds: ["INBOX"], removeLabelIds: ["TRASH"] }
          : action === "markUnread"
            ? { addLabelIds: ["UNREAD"] }
            : null;
    for (const m of raw.messages ?? []) {
      const labels = m.labelIds ?? [];
      if (gmailMutationAlreadyApplied(action, labels)) {
        processed.push(m.id);
        continue;
      }
      try {
        if (action === "trash") {
          await this.post(`/messages/${m.id}/trash`, {});
        } else {
          await this.post(`/messages/${m.id}/modify`, body);
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
    return nativeUrlFor("google", id);
  }
}
