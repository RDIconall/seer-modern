import type {
  MailFolder,
  MailMessageDetail,
  MailMessageListItem,
  SendMailInput,
} from "@/lib/mail/types";

export type {
  MailFolder,
  MailMessageDetail,
  MailMessageListItem,
  SendMailInput,
} from "@/lib/mail/types";

function parseAddress(raw: string): { name: string; email: string } {
  const m = raw.match(/^(?:"?([^"]*)"?\s)?<?([^>]+@[^>]+)>?$/);
  if (m) return { name: (m[1] ?? m[2]).trim(), email: m[2].trim() };
  return { name: raw, email: raw };
}

function decodeBase64Url(data: string): string {
  const padded = data.replace(/-/g, "+").replace(/_/g, "/");
  return Buffer.from(padded, "base64").toString("utf8");
}

function encodeBase64Url(data: string): string {
  return Buffer.from(data, "utf8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function extractBodies(payload: GmailPayload): { text: string; html: string } {
  let text = "";
  let html = "";
  function walk(part: GmailPayload) {
    if (part.mimeType === "text/plain" && part.body?.data) {
      text += decodeBase64Url(part.body.data);
    } else if (part.mimeType === "text/html" && part.body?.data) {
      html += decodeBase64Url(part.body.data);
    }
    part.parts?.forEach(walk);
  }
  if (payload.body?.data) {
    if (payload.mimeType === "text/plain")
      text = decodeBase64Url(payload.body.data);
    if (payload.mimeType === "text/html")
      html = decodeBase64Url(payload.body.data);
  }
  walk(payload);
  return { text, html };
}

type GmailPayload = {
  mimeType?: string;
  body?: { data?: string; size?: number };
  parts?: GmailPayload[];
  headers?: { name: string; value: string }[];
};

async function gmailFetch(
  accessToken: string,
  path: string,
  init?: RequestInit,
) {
  const res = await fetch(`https://gmail.googleapis.com/gmail/v1${path}`, {
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
    throw new Error(`Gmail ${path}: ${res.status} ${err.slice(0, 300)}`);
  }
  if (res.status === 204) return null;
  return res.json();
}

function folderToQuery(folder: MailFolder, q?: string): string {
  const base =
    folder === "inbox"
      ? "in:inbox"
      : folder === "sent"
        ? "in:sent"
        : "in:trash";
  const extra = q?.trim();
  return extra ? `${base} ${extra}` : base;
}

async function hydrateList(
  accessToken: string,
  messages: { id: string; threadId: string }[],
): Promise<MailMessageListItem[]> {
  const items: MailMessageListItem[] = [];
  for (const m of messages) {
    const msg = (await gmailFetch(
      accessToken,
      `/users/me/messages/${m.id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=To`,
    )) as {
      id: string;
      threadId: string;
      snippet?: string;
      internalDate?: string;
      labelIds?: string[];
      payload?: GmailPayload;
    };
    const headers = msg.payload?.headers ?? [];
    const fromRaw = headers.find((h) => h.name === "From")?.value ?? "";
    const { name, email } = parseAddress(fromRaw);
    items.push({
      id: msg.id,
      threadId: msg.threadId,
      fromEmail: email,
      fromName: name,
      subject:
        headers.find((h) => h.name === "Subject")?.value ?? "(no subject)",
      snippet: msg.snippet ?? "",
      receivedAt: msg.internalDate
        ? new Date(Number(msg.internalDate)).toISOString()
        : new Date().toISOString(),
      isUnread: (msg.labelIds ?? []).includes("UNREAD"),
    });
  }
  return items;
}

export async function listGmailInbox(
  accessToken: string,
  maxResults = 40,
): Promise<MailMessageListItem[]> {
  return listGmailFolder(accessToken, "inbox", maxResults);
}

export async function listGmailFolder(
  accessToken: string,
  folder: MailFolder,
  maxResults = 40,
  q?: string,
): Promise<MailMessageListItem[]> {
  const query = encodeURIComponent(folderToQuery(folder, q));
  const list = (await gmailFetch(
    accessToken,
    `/users/me/messages?q=${query}&maxResults=${maxResults}`,
  )) as { messages?: { id: string; threadId: string }[] };
  return hydrateList(accessToken, list.messages ?? []);
}

export async function searchGmail(
  accessToken: string,
  q: string,
  maxResults = 40,
): Promise<MailMessageListItem[]> {
  const query = encodeURIComponent(q.trim());
  if (!query) return [];
  const list = (await gmailFetch(
    accessToken,
    `/users/me/messages?q=${query}&maxResults=${maxResults}`,
  )) as { messages?: { id: string; threadId: string }[] };
  return hydrateList(accessToken, list.messages ?? []);
}

export async function getGmailMessage(
  accessToken: string,
  id: string,
): Promise<MailMessageDetail> {
  const msg = (await gmailFetch(
    accessToken,
    `/users/me/messages/${id}?format=full`,
  )) as {
    id: string;
    threadId: string;
    snippet?: string;
    internalDate?: string;
    labelIds?: string[];
    payload: GmailPayload;
  };
  const headers = msg.payload.headers ?? [];
  const header = (name: string) =>
    headers.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value ??
    "";
  const fromRaw = header("From");
  const { name, email } = parseAddress(fromRaw);
  const { text, html } = extractBodies(msg.payload);
  return {
    id: msg.id,
    threadId: msg.threadId,
    fromEmail: email,
    fromName: name,
    subject: header("Subject") || "(no subject)",
    snippet: msg.snippet ?? "",
    receivedAt: msg.internalDate
      ? new Date(Number(msg.internalDate)).toISOString()
      : new Date().toISOString(),
    isUnread: (msg.labelIds ?? []).includes("UNREAD"),
    textBody: text,
    htmlBody: html,
    toEmail: header("To"),
    ccEmail: header("Cc"),
    messageIdHeader: header("Message-ID") || header("Message-Id"),
  };
}

function buildMime(input: SendMailInput): string {
  const lines = [
    `To: ${input.to}`,
    ...(input.cc?.trim() ? [`Cc: ${input.cc.trim()}`] : []),
    `Subject: ${input.subject}`,
    "MIME-Version: 1.0",
    'Content-Type: text/plain; charset="UTF-8"',
    ...(input.inReplyTo ? [`In-Reply-To: ${input.inReplyTo}`] : []),
    ...(input.references ? [`References: ${input.references}`] : []),
    "",
    input.body,
  ];
  return lines.join("\r\n");
}

export async function sendGmailMessage(
  accessToken: string,
  input: SendMailInput,
): Promise<{ id: string; threadId: string }> {
  const raw = encodeBase64Url(buildMime(input));
  const body: { raw: string; threadId?: string } = { raw };
  if (input.threadId) body.threadId = input.threadId;
  const sent = (await gmailFetch(accessToken, `/users/me/messages/send`, {
    method: "POST",
    body: JSON.stringify(body),
  })) as { id: string; threadId: string };
  return { id: sent.id, threadId: sent.threadId };
}

export async function gmailAction(
  accessToken: string,
  id: string,
  action: "archive" | "trash" | "read",
) {
  if (action === "trash") {
    await gmailFetch(accessToken, `/users/me/messages/${id}/trash`, {
      method: "POST",
    });
    return;
  }
  const body: { removeLabelIds?: string[]; addLabelIds?: string[] } = {};
  if (action === "archive") body.removeLabelIds = ["INBOX"];
  if (action === "read") body.removeLabelIds = ["UNREAD"];
  await gmailFetch(accessToken, `/users/me/messages/${id}/modify`, {
    method: "POST",
    body: JSON.stringify(body),
  });
}
