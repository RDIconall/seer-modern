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

function extractBodies(payload: GmailPayload): {
  text: string;
  html: string;
  icalUid?: string;
} {
  let text = "";
  let html = "";
  let icalUid: string | undefined;
  function walk(part: GmailPayload) {
    if (part.mimeType === "text/plain" && part.body?.data) {
      text += decodeBase64Url(part.body.data);
    } else if (part.mimeType === "text/html" && part.body?.data) {
      html += decodeBase64Url(part.body.data);
    } else if (part.mimeType === "text/calendar" && part.body?.data) {
      // The invite's own .ics names the exact event — no guessing
      const m = decodeBase64Url(part.body.data).match(/^UID:(.+)$/m);
      if (m) icalUid = m[1].trim();
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
  return { text, html, icalUid };
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
    if (
      res.status === 403 &&
      /insufficient|ACCESS_TOKEN_SCOPE/i.test(err)
    ) {
      throw new Error(
        "Gmail permissions are incomplete — open Settings and tap Reconnect on this account, then approve all access on Google's screen.",
      );
    }
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

/** Superhuman-style: hydrate metadata in parallel, not one-by-one. */
const HYDRATE_CONCURRENCY = 10;

async function hydrateOne(
  accessToken: string,
  m: { id: string; threadId: string },
): Promise<MailMessageListItem> {
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
  const toRaw = headers.find((h) => h.name === "To")?.value ?? "";
  const { name, email } = parseAddress(fromRaw);
  const firstTo = toRaw.split(",")[0]?.trim() ?? "";
  const peer = firstTo ? parseAddress(firstTo).email : undefined;
  return {
    id: msg.id,
    threadId: msg.threadId,
    fromEmail: email,
    fromName: name,
    peerEmail: peer,
    subject:
      headers.find((h) => h.name === "Subject")?.value ?? "(no subject)",
    snippet: msg.snippet ?? "",
    receivedAt: msg.internalDate
      ? new Date(Number(msg.internalDate)).toISOString()
      : new Date().toISOString(),
    isUnread: (msg.labelIds ?? []).includes("UNREAD"),
    labelIds: msg.labelIds ?? [],
  };
}

async function hydrateList(
  accessToken: string,
  messages: { id: string; threadId: string }[],
): Promise<MailMessageListItem[]> {
  const items: MailMessageListItem[] = [];
  for (let i = 0; i < messages.length; i += HYDRATE_CONCURRENCY) {
    const chunk = messages.slice(i, i + HYDRATE_CONCURRENCY);
    const hydrated = await Promise.all(
      chunk.map((m) => hydrateOne(accessToken, m)),
    );
    items.push(...hydrated);
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
  // Paginate until the WHOLE folder is in (up to maxResults) — the app's
  // job is inbox zero, so it must see everything, not the first page.
  const ids: { id: string; threadId: string }[] = [];
  let pageToken: string | undefined;
  while (ids.length < maxResults) {
    const page = Math.min(500, maxResults - ids.length);
    const list = (await gmailFetch(
      accessToken,
      `/users/me/messages?q=${query}&maxResults=${page}${
        pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ""
      }`,
    )) as {
      messages?: { id: string; threadId: string }[];
      nextPageToken?: string;
    };
    ids.push(...(list.messages ?? []));
    pageToken = list.nextPageToken;
    if (!pageToken || !list.messages?.length) break;
  }
  return hydrateList(accessToken, ids.slice(0, maxResults));
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

/** Who spoke LAST in a thread — the fact that decides "answered or not". */
export async function getGmailThreadLast(
  accessToken: string,
  threadId: string,
): Promise<{ fromEmail: string; receivedAt: string; id: string } | null> {
  try {
    const t = (await gmailFetch(
      accessToken,
      `/users/me/threads/${threadId}?format=metadata&metadataHeaders=From`,
    )) as {
      messages?: {
        id: string;
        internalDate?: string;
        payload?: { headers?: { name: string; value: string }[] };
      }[];
    };
    const msgs = t.messages ?? [];
    const last = msgs[msgs.length - 1];
    if (!last) return null;
    const fromRaw =
      last.payload?.headers?.find((h) => h.name === "From")?.value ?? "";
    const { email } = parseAddress(fromRaw);
    return {
      id: last.id,
      fromEmail: email.toLowerCase(),
      receivedAt: last.internalDate
        ? new Date(Number(last.internalDate)).toISOString()
        : new Date().toISOString(),
    };
  } catch {
    return null;
  }
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
  const { text, html, icalUid } = extractBodies(msg.payload);
  return {
    icalUid,
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
    labelIds: msg.labelIds ?? [],
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
