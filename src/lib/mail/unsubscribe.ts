import { sendGmailMessage } from "@/lib/mail/gmail";
import { sendGraphMessage } from "@/lib/mail/graph";

/**
 * Actually get the user OFF the list, not just trash the email.
 * Standards-based, no scraping:
 * - RFC 8058 one-click: POST the List-Unsubscribe URL server-side. Done.
 * - mailto: variant: send the unsubscribe email from the user's account.
 * - Plain https link: hand the URL back for one tap.
 */

export type UnsubscribeResult =
  | { method: "one-click" }
  | { method: "mailto" }
  | { method: "link"; url: string }
  | { method: "none" };

type Parsed = { https?: string; mailto?: string; oneClick: boolean };

function parseHeaders(
  listUnsub: string | undefined,
  listUnsubPost: string | undefined,
): Parsed {
  const out: Parsed = { oneClick: /one-click/i.test(listUnsubPost ?? "") };
  for (const m of (listUnsub ?? "").matchAll(/<([^>]+)>/g)) {
    const url = m[1].trim();
    if (/^https?:\/\//i.test(url) && !out.https) out.https = url;
    if (/^mailto:/i.test(url) && !out.mailto) out.mailto = url;
  }
  return out;
}

async function perform(
  parsed: Parsed,
  sendMail: (to: string, subject: string) => Promise<void>,
): Promise<UnsubscribeResult> {
  // 1. RFC 8058 one-click — silent, instant, nothing for the user to do
  if (parsed.https && parsed.oneClick) {
    try {
      const res = await fetch(parsed.https, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: "List-Unsubscribe=One-Click",
        redirect: "follow",
        signal: AbortSignal.timeout(8000),
      });
      if (res.ok || res.status === 202) return { method: "one-click" };
    } catch {
      /* fall through */
    }
  }

  // 2. mailto: — send the unsubscribe email as the user
  if (parsed.mailto) {
    try {
      const u = new URL(parsed.mailto);
      const to = u.pathname;
      const subject = u.searchParams.get("subject") ?? "unsubscribe";
      if (to.includes("@")) {
        await sendMail(to, subject);
        return { method: "mailto" };
      }
    } catch {
      /* fall through */
    }
  }

  // 3. Plain link — the user taps it once
  if (parsed.https) return { method: "link", url: parsed.https };
  return { method: "none" };
}

export async function unsubscribeGmail(
  accessToken: string,
  messageId: string,
): Promise<UnsubscribeResult> {
  const res = await fetch(
    `https://gmail.googleapis.com/gmail/v1/users/me/messages/${messageId}?format=metadata&metadataHeaders=List-Unsubscribe&metadataHeaders=List-Unsubscribe-Post`,
    {
      headers: { Authorization: `Bearer ${accessToken}` },
      cache: "no-store",
    },
  );
  if (!res.ok) return { method: "none" };
  const msg = (await res.json()) as {
    payload?: { headers?: { name: string; value: string }[] };
  };
  const header = (name: string) =>
    msg.payload?.headers?.find(
      (h) => h.name.toLowerCase() === name.toLowerCase(),
    )?.value;

  const parsed = parseHeaders(
    header("List-Unsubscribe"),
    header("List-Unsubscribe-Post"),
  );
  return perform(parsed, async (to, subject) => {
    await sendGmailMessage(accessToken, { to, subject, body: "unsubscribe" });
  });
}

export async function unsubscribeGraph(
  accessToken: string,
  messageId: string,
): Promise<UnsubscribeResult> {
  const res = await fetch(
    `https://graph.microsoft.com/v1.0/me/messages/${messageId}?$select=internetMessageHeaders`,
    {
      headers: { Authorization: `Bearer ${accessToken}` },
      cache: "no-store",
    },
  );
  if (!res.ok) return { method: "none" };
  const msg = (await res.json()) as {
    internetMessageHeaders?: { name: string; value: string }[];
  };
  const header = (name: string) =>
    msg.internetMessageHeaders?.find(
      (h) => h.name.toLowerCase() === name.toLowerCase(),
    )?.value;

  const parsed = parseHeaders(
    header("List-Unsubscribe"),
    header("List-Unsubscribe-Post"),
  );
  return perform(parsed, async (to, subject) => {
    await sendGraphMessage(accessToken, { to, subject, body: "unsubscribe" });
  });
}
