import { auth } from "@/auth";
import { NextResponse } from "next/server";

export type MailRow = {
  id?: string;
  subject: string;
  from: string;
  receivedAt: string;
  snippet?: string;
};

async function fetchGmailMessages(
  accessToken: string,
  includeSnippets: boolean,
): Promise<MailRow[]> {
  const listRes = await fetch(
    "https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=8",
    { headers: { Authorization: `Bearer ${accessToken}` }, cache: "no-store" },
  );
  if (!listRes.ok) {
    const err = await listRes.text();
    throw new Error(`Gmail list failed: ${listRes.status} ${err}`);
  }
  const list = (await listRes.json()) as {
    messages?: { id: string }[];
  };
  const ids = list.messages?.map((m) => m.id) ?? [];
  const rows: MailRow[] = [];

  for (const id of ids) {
    const fields = includeSnippets
      ? "id,snippet,internalDate,payload(headers)"
      : "internalDate,payload(headers)";
    const msgRes = await fetch(
      `https://gmail.googleapis.com/gmail/v1/users/me/messages/${id}?fields=${encodeURIComponent(fields)}`,
      { headers: { Authorization: `Bearer ${accessToken}` }, cache: "no-store" },
    );
    if (!msgRes.ok) continue;
    const msg = (await msgRes.json()) as {
      id?: string;
      snippet?: string;
      internalDate?: string;
      payload?: { headers?: { name: string; value: string }[] };
    };
    const headers = msg.payload?.headers ?? [];
    const subject =
      headers.find((h) => h.name === "Subject")?.value ?? "(no subject)";
    const from = headers.find((h) => h.name === "From")?.value ?? "";
    const receivedAt = msg.internalDate
      ? new Date(Number(msg.internalDate)).toISOString()
      : "";
    rows.push({
      id: msg.id ?? id,
      subject,
      from,
      receivedAt,
      snippet: includeSnippets ? msg.snippet : undefined,
    });
  }
  return rows;
}

async function fetchGraphMessages(
  accessToken: string,
  includeSnippets: boolean,
): Promise<MailRow[]> {
  const url = new URL("https://graph.microsoft.com/v1.0/me/messages");
  url.searchParams.set("$top", "10");
  url.searchParams.set("$orderby", "receivedDateTime desc");
  const select = includeSnippets
    ? "id,subject,from,receivedDateTime,bodyPreview"
    : "id,subject,from,receivedDateTime";
  url.searchParams.set("$select", select);

  const res = await fetch(url.toString(), {
    headers: { Authorization: `Bearer ${accessToken}` },
    cache: "no-store",
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Microsoft Graph failed: ${res.status} ${err}`);
  }
  const data = (await res.json()) as {
    value?: {
      id?: string;
      subject?: string;
      bodyPreview?: string;
      from?: { emailAddress?: { name?: string; address?: string } };
      receivedDateTime?: string;
    }[];
  };
  return (data.value ?? []).map((m) => ({
    id: m.id,
    subject: m.subject ?? "(no subject)",
    from: m.from?.emailAddress
      ? `${m.from.emailAddress.name ?? ""} <${m.from.emailAddress.address ?? ""}>`.trim()
      : "",
    receivedAt: m.receivedDateTime ?? "",
    snippet: includeSnippets ? m.bodyPreview : undefined,
  }));
}

export async function GET(request: Request) {
  const session = await auth();
  if (!session?.accessToken || !session.provider) {
    return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  }

  const { searchParams } = new URL(request.url);
  const includeSnippets =
    searchParams.get("snippets") === "1" ||
    searchParams.get("snippets") === "true";

  try {
    if (session.provider === "google") {
      const items = await fetchGmailMessages(session.accessToken, includeSnippets);
      return NextResponse.json({ provider: "google", items });
    }
    if (session.provider === "microsoft-entra-id") {
      const items = await fetchGraphMessages(
        session.accessToken,
        includeSnippets,
      );
      return NextResponse.json({ provider: "microsoft-entra-id", items });
    }
    return NextResponse.json(
      { error: `Unsupported provider: ${session.provider}` },
      { status: 400 },
    );
  } catch (e) {
    const message = e instanceof Error ? e.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
