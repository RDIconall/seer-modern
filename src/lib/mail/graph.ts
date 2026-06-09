import type { MailMessageDetail, MailMessageListItem } from "@/lib/mail/gmail";

async function graphFetch(accessToken: string, path: string, init?: RequestInit) {
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

export async function listGraphInbox(
  accessToken: string,
  maxResults = 40,
): Promise<MailMessageListItem[]> {
  const url = new URL("https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages");
  url.searchParams.set("$top", String(maxResults));
  url.searchParams.set("$orderby", "receivedDateTime desc");
  url.searchParams.set(
    "$select",
    "id,conversationId,subject,bodyPreview,receivedDateTime,isRead,from",
  );
  const res = await fetch(url.toString(), {
    headers: { Authorization: `Bearer ${accessToken}` },
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`Graph inbox: ${res.status}`);
  const data = (await res.json()) as {
    value?: {
      id: string;
      conversationId: string;
      subject?: string;
      bodyPreview?: string;
      receivedDateTime?: string;
      isRead?: boolean;
      from?: { emailAddress?: { name?: string; address?: string } };
    }[];
  };
  return (data.value ?? []).map((m) => ({
    id: m.id,
    threadId: m.conversationId,
    fromEmail: m.from?.emailAddress?.address ?? "",
    fromName: m.from?.emailAddress?.name ?? m.from?.emailAddress?.address ?? "",
    subject: m.subject ?? "(no subject)",
    snippet: m.bodyPreview ?? "",
    receivedAt: m.receivedDateTime ?? new Date().toISOString(),
    isUnread: !m.isRead,
  }));
}

export async function getGraphMessage(
  accessToken: string,
  id: string,
): Promise<MailMessageDetail> {
  const m = (await graphFetch(
    accessToken,
    `/me/messages/${id}?$select=id,conversationId,subject,body,bodyPreview,receivedDateTime,isRead,from`,
  )) as {
    id: string;
    conversationId: string;
    subject?: string;
    bodyPreview?: string;
    body?: { contentType?: string; content?: string };
    receivedDateTime?: string;
    isRead?: boolean;
    from?: { emailAddress?: { name?: string; address?: string } };
  };
  const html =
    m.body?.contentType === "html" ? (m.body.content ?? "") : "";
  const text =
    m.body?.contentType === "text"
      ? (m.body.content ?? "")
      : m.bodyPreview ?? "";
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
  };
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
