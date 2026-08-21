import type {
  MailFolder,
  MailMessageDetail,
  MailMessageListItem,
  SendMailInput,
} from "@/lib/mail/types";
import { compileOutlookSearch, parseMailSearch } from "@/lib/v3/search/parser";

/**
 * Graph throttles bursts with 429 + Retry-After. One throttled call
 * must never sink a whole inbox load — honor the header, retry, then
 * fail only if Graph keeps saying no.
 */
export async function graphRawFetch(
  url: string,
  init: RequestInit,
): Promise<Response> {
  let last: Response | null = null;
  for (let attempt = 0; attempt < 4; attempt++) {
    if (attempt > 0) {
      const retryAfter = Number(last?.headers.get("retry-after") ?? 0);
      const wait =
        retryAfter > 0 ? Math.min(retryAfter, 12) * 1000 : 500 * 2 ** attempt;
      await new Promise((r) => setTimeout(r, wait));
    }
    const res = await fetch(url, init);
    if (res.ok || (res.status !== 429 && res.status < 500)) return res;
    last = res;
  }
  return last as Response;
}

async function graphFetch(
  accessToken: string,
  path: string,
  init?: RequestInit,
) {
  const res = await graphRawFetch(`https://graph.microsoft.com/v1.0${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
      ...init?.headers,
    },
    cache: "no-store",
  });
  if (!res.ok) {
    const err = await res.text();
    if (res.status === 403 && /AccessDenied|Authorization_RequestDenied/i.test(err)) {
      throw new Error(
        "Outlook permissions are incomplete — open Settings and tap Reconnect on this account, then approve all access on Microsoft's screen.",
      );
    }
    throw new Error(`Graph ${path}: ${res.status} ${err.slice(0, 300)}`);
  }
  // sendMail, reply and replyAll answer 202 Accepted with NO body. Calling
  // res.json() on that throws "Unexpected end of JSON input", which the send
  // route then reported as a failure — for mail Microsoft had already
  // accepted. Success with an empty body is success.
  const text = await res.text();
  if (!text) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

type GraphMessage = {
  id: string;
  conversationId: string;
  subject?: string;
  bodyPreview?: string;
  body?: { contentType?: string; content?: string };
  receivedDateTime?: string;
  sentDateTime?: string;
  isRead?: boolean;
  from?: { emailAddress?: { name?: string; address?: string } };
  toRecipients?: { emailAddress?: { name?: string; address?: string } }[];
  ccRecipients?: { emailAddress?: { name?: string; address?: string } }[];
  internetMessageId?: string;
};

function mapListItem(m: GraphMessage): MailMessageListItem {
  const peer = m.toRecipients?.[0]?.emailAddress?.address;
  return {
    id: m.id,
    threadId: m.conversationId,
    fromEmail: m.from?.emailAddress?.address ?? "",
    fromName:
      m.from?.emailAddress?.name ?? m.from?.emailAddress?.address ?? "",
    peerEmail: peer,
    subject: m.subject ?? "(no subject)",
    snippet: m.bodyPreview ?? "",
    receivedAt:
      m.receivedDateTime ?? m.sentDateTime ?? new Date().toISOString(),
    isUnread: !m.isRead,
  };
}

function folderPath(folder: MailFolder): string {
  if (folder === "sent") return "/me/mailFolders/sentitems/messages";
  if (folder === "trash") return "/me/mailFolders/deleteditems/messages";
  return "/me/mailFolders/inbox/messages";
}

/** The authoritative inbox size, straight from Graph. */
export async function getGraphInboxTotals(
  accessToken: string,
): Promise<{ messages: number; threads: number } | null> {
  try {
    const r = (await graphFetch(
      accessToken,
      "/me/mailFolders/inbox?$select=totalItemCount",
    )) as { totalItemCount?: number };
    return { messages: r.totalItemCount ?? 0, threads: 0 };
  } catch {
    return null;
  }
}

export async function listGraphInbox(
  accessToken: string,
  maxResults = 40,
): Promise<MailMessageListItem[]> {
  return listGraphFolder(accessToken, "inbox", maxResults);
}

export async function listGraphFolder(
  accessToken: string,
  folder: MailFolder,
  maxResults = 40,
  q?: string,
): Promise<MailMessageListItem[]> {
  if (q?.trim()) {
    return searchGraph(accessToken, q, maxResults, folder);
  }
  const first = new URL(
    `https://graph.microsoft.com/v1.0${folderPath(folder)}`,
  );
  first.searchParams.set("$top", String(Math.min(500, maxResults)));
  first.searchParams.set("$orderby", "receivedDateTime desc");
  first.searchParams.set(
    "$select",
    "id,conversationId,subject,bodyPreview,receivedDateTime,sentDateTime,isRead,from,toRecipients",
  );

  // Follow @odata.nextLink until the whole folder (up to maxResults) is
  // in — inbox zero needs the full picture, not the first page.
  const out: MailMessageListItem[] = [];
  let next: string | undefined = first.toString();
  while (next && out.length < maxResults) {
    const res = await graphRawFetch(next, {
      headers: { Authorization: `Bearer ${accessToken}` },
      cache: "no-store",
    });
    if (!res.ok) {
      // A page that still won't come after retries: serve what we have
      // rather than failing the whole load with nothing.
      if (out.length > 0) break;
      throw new Error(`Graph folder ${folder}: ${res.status}`);
    }
    const data = (await res.json()) as {
      value?: GraphMessage[];
      "@odata.nextLink"?: string;
    };
    out.push(...(data.value ?? []).map(mapListItem));
    next = data["@odata.nextLink"];
    if (!data.value?.length) break;
  }
  return out.slice(0, maxResults);
}

export async function searchGraph(
  accessToken: string,
  q: string,
  maxResults = 40,
  folder?: MailFolder,
): Promise<MailMessageListItem[]> {
  const term = compileOutlookSearch(parseMailSearch(q.trim())).replace(
    /"/g,
    "",
  );
  if (!term) return [];
  const path = folder ? folderPath(folder) : "/me/messages";
  const url = new URL(`https://graph.microsoft.com/v1.0${path}`);
  url.searchParams.set("$top", String(maxResults));
  url.searchParams.set("$search", `"${term}"`);
  url.searchParams.set(
    "$select",
    "id,conversationId,subject,bodyPreview,receivedDateTime,sentDateTime,isRead,from,toRecipients",
  );
  const res = await graphRawFetch(url.toString(), {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      ConsistencyLevel: "eventual",
    },
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`Graph search: ${res.status}`);
  const data = (await res.json()) as { value?: GraphMessage[] };
  return (data.value ?? []).map(mapListItem);
}

function recipientsToString(
  list?: { emailAddress?: { name?: string; address?: string } }[],
): string {
  return (list ?? [])
    .map((r) => r.emailAddress?.address)
    .filter(Boolean)
    .join(", ");
}

export async function getGraphMessage(
  accessToken: string,
  id: string,
): Promise<MailMessageDetail> {
  const m = (await graphFetch(
    accessToken,
    `/me/messages/${id}?$select=id,conversationId,subject,body,bodyPreview,receivedDateTime,isRead,from,toRecipients,ccRecipients,internetMessageId,hasAttachments`,
  )) as GraphMessage & { hasAttachments?: boolean };

  let attachments: MailMessageDetail["attachments"];
  if (m.hasAttachments) {
    const list = (await graphFetch(
      accessToken,
      `/me/messages/${id}/attachments?$select=id,name,contentType,size`,
    ).catch(() => null)) as {
      value?: { id: string; name?: string; contentType?: string; size?: number }[];
    } | null;
    attachments = (list?.value ?? []).map((a) => ({
      id: a.id,
      filename: a.name ?? "attachment",
      mimeType: a.contentType ?? "application/octet-stream",
      size: a.size ?? 0,
    }));
  }
  const html = m.body?.contentType === "html" ? (m.body.content ?? "") : "";
  const text =
    m.body?.contentType === "text"
      ? (m.body.content ?? "")
      : (m.bodyPreview ?? "");
  return {
    id: m.id,
    threadId: m.conversationId,
    fromEmail: m.from?.emailAddress?.address ?? "",
    fromName: m.from?.emailAddress?.name ?? "",
    subject: m.subject ?? "(no subject)",
    snippet: m.bodyPreview ?? "",
    receivedAt: m.receivedDateTime ?? new Date().toISOString(),
    isUnread: !m.isRead,
    textBody: text,
    htmlBody: html,
    toEmail: recipientsToString(m.toRecipients),
    ccEmail: recipientsToString(m.ccRecipients),
    messageIdHeader: m.internetMessageId ?? "",
    attachments,
  };
}

export async function getGraphConversationMessages(
  accessToken: string,
  conversationId: string,
): Promise<MailMessageDetail[]> {
  const safeId = conversationId.replaceAll("'", "''");
  const page = (await graphFetch(
    accessToken,
    `/me/messages?$filter=conversationId eq '${safeId}'&$select=id&$top=100`,
  )) as { value?: { id: string }[] };
  const messages = await Promise.all(
    (page.value ?? []).map((message) =>
      getGraphMessage(accessToken, message.id),
    ),
  );
  return messages.sort((a, b) => a.receivedAt.localeCompare(b.receivedAt));
}

/** Raw attachment bytes (fileAttachment contentBytes). */
export async function getGraphAttachment(
  accessToken: string,
  messageId: string,
  attachmentId: string,
): Promise<Buffer> {
  const res = await graphRawFetch(
    `https://graph.microsoft.com/v1.0/me/messages/${messageId}/attachments/${attachmentId}/$value`,
    { headers: { Authorization: `Bearer ${accessToken}` }, cache: "no-store" },
  );
  if (!res.ok) throw new Error(`Graph attachment: ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

function parseAddresses(raw: string): { emailAddress: { address: string } }[] {
  return raw
    .split(/[,;]/)
    .map((s) => s.trim())
    .filter(Boolean)
    .map((address) => {
      const m = address.match(/<([^>]+)>/);
      return { emailAddress: { address: (m?.[1] ?? address).trim() } };
    });
}

export async function sendGraphMessage(
  accessToken: string,
  input: SendMailInput,
): Promise<{ id: string }> {
  await graphFetch(accessToken, `/me/sendMail`, {
    method: "POST",
    body: JSON.stringify({
      message: {
        subject: input.subject,
        body: input.html
          ? { contentType: "HTML", content: input.html }
          : { contentType: "Text", content: input.body },
        toRecipients: parseAddresses(input.to),
        ...(input.cc?.trim()
          ? { ccRecipients: parseAddresses(input.cc) }
          : {}),
      },
      saveToSentItems: true,
    }),
  });
  return { id: "sent" };
}

export async function replyGraphMessage(
  accessToken: string,
  id: string,
  body: string,
  replyAll = false,
): Promise<void> {
  const path = replyAll
    ? `/me/messages/${id}/replyAll`
    : `/me/messages/${id}/reply`;
  await graphFetch(accessToken, path, {
    method: "POST",
    body: JSON.stringify({ comment: body }),
  });
}

export async function graphAction(
  accessToken: string,
  id: string,
  action: "archive" | "trash" | "read",
) {
  if (action === "trash") {
    await graphFetch(accessToken, `/me/messages/${id}`, { method: "DELETE" });
    return;
  }
  if (action === "read") {
    await graphFetch(accessToken, `/me/messages/${id}`, {
      method: "PATCH",
      body: JSON.stringify({ isRead: true }),
    });
    return;
  }
  const folders = (await graphFetch(
    accessToken,
    `/me/mailFolders?$filter=displayName eq 'Archive'&$select=id`,
  )) as { value?: { id: string }[] };
  const archiveId = folders.value?.[0]?.id;
  if (!archiveId) {
    await graphFetch(accessToken, `/me/messages/${id}`, {
      method: "PATCH",
      body: JSON.stringify({ isRead: true }),
    });
    return;
  }
  await graphFetch(accessToken, `/me/messages/${id}/move`, {
    method: "POST",
    body: JSON.stringify({ destinationId: archiveId }),
  });
}

/**
 * Outlook has no thread endpoint — find every inbox message in the
 * conversation and act on each, so the whole thread clears at once.
 */
export async function graphThreadAction(
  accessToken: string,
  conversationId: string,
  action: "archive" | "trash" | "read",
) {
  const url = new URL(
    "https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages",
  );
  url.searchParams.set(
    "$filter",
    `conversationId eq '${conversationId.replace(/'/g, "''")}'`,
  );
  url.searchParams.set("$select", "id");
  url.searchParams.set("$top", "50");
  const res = await graphRawFetch(url.toString(), {
    headers: { Authorization: `Bearer ${accessToken}` },
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`Graph thread lookup: ${res.status}`);
  const data = (await res.json()) as { value?: { id: string }[] };
  const ids = (data.value ?? []).map((m) => m.id);
  await Promise.allSettled(ids.map((id) => graphAction(accessToken, id, action)));
}
