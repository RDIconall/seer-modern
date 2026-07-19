import type {
  MailFolder,
  MailMessageDetail,
  MailMessageListItem,
  SendMailInput,
} from "@/lib/mail/types";

async function graphFetch(
  accessToken: string,
  path: string,
  init?: RequestInit,
) {
  const res = await fetch(`https://graph.microsoft.com/v1.0${path}`, {
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
    throw new Error(`Graph ${path}: ${res.status} ${err.slice(0, 300)}`);
  }
  if (res.status === 204) return null;
  return res.json();
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
  return {
    id: m.id,
    threadId: m.conversationId,
    fromEmail: m.from?.emailAddress?.address ?? "",
    fromName:
      m.from?.emailAddress?.name ?? m.from?.emailAddress?.address ?? "",
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
  const url = new URL(`https://graph.microsoft.com/v1.0${folderPath(folder)}`);
  url.searchParams.set("$top", String(maxResults));
  url.searchParams.set("$orderby", "receivedDateTime desc");
  url.searchParams.set(
    "$select",
    "id,conversationId,subject,bodyPreview,receivedDateTime,sentDateTime,isRead,from",
  );
  const res = await fetch(url.toString(), {
    headers: { Authorization: `Bearer ${accessToken}` },
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`Graph folder ${folder}: ${res.status}`);
  const data = (await res.json()) as { value?: GraphMessage[] };
  return (data.value ?? []).map(mapListItem);
}

export async function searchGraph(
  accessToken: string,
  q: string,
  maxResults = 40,
  folder?: MailFolder,
): Promise<MailMessageListItem[]> {
  const term = q.trim().replace(/"/g, "");
  if (!term) return [];
  const path = folder ? folderPath(folder) : "/me/messages";
  const url = new URL(`https://graph.microsoft.com/v1.0${path}`);
  url.searchParams.set("$top", String(maxResults));
  url.searchParams.set("$search", `"${term}"`);
  url.searchParams.set(
    "$select",
    "id,conversationId,subject,bodyPreview,receivedDateTime,sentDateTime,isRead,from",
  );
  const res = await fetch(url.toString(), {
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
    `/me/messages/${id}?$select=id,conversationId,subject,body,bodyPreview,receivedDateTime,isRead,from,toRecipients,ccRecipients,internetMessageId`,
  )) as GraphMessage;
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
  };
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
        body: { contentType: "Text", content: input.body },
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
