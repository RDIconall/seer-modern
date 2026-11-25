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
  | { method: "mailto"; to: string }
  | { method: "link"; url: string }
  | { method: "none" };

type Parsed = {
  https?: string;
  mailto?: string;
  oneClick: boolean;
  senderDomains: string[];
};

/**
 * The List-Unsubscribe header is written by whoever sent the message, so
 * the mailto target is untrusted: it is sent from the user's own account
 * only to one plain address on the sender's domain, always with this text.
 */
const MAILTO_SUBJECT = "unsubscribe";
const MAILTO_BODY = "unsubscribe";

const ADDRESS =
  /^[A-Za-z0-9!#$%&'*+/=?^_`{|}~.-]+@([A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)+)$/;

function domainOf(address: string): string | null {
  const m = address.match(ADDRESS);
  return m ? m[1].toLowerCase() : null;
}

function headerAddress(value: string | undefined): string | null {
  if (!value) return null;
  const bracketed = [...value.matchAll(/<([^<>]*)>/g)];
  const address = (
    bracketed.length ? bracketed[bracketed.length - 1][1] : value
  ).trim();
  return domainOf(address) ? address : null;
}

/**
 * The single recipient a mailto: URI names, or null when it names anything
 * other than exactly one well-formed address. Query fields (subject, body,
 * cc, bcc, to) are never read.
 */
function mailtoAddress(uri: string): string | null {
  const m = uri.match(/^mailto:([^?#]*)/i);
  if (!m) return null;
  let address: string;
  try {
    address = decodeURIComponent(m[1]).trim();
  } catch {
    return null;
  }
  return domainOf(address) ? address : null;
}

function allowedRecipient(address: string, senderDomains: string[]): boolean {
  const domain = domainOf(address);
  if (!domain) return false;
  return senderDomains.some(
    (sender) => domain === sender || domain.endsWith(`.${sender}`),
  );
}

function parseHeaders(header: (name: string) => string | undefined): Parsed {
  const out: Parsed = {
    oneClick: /one-click/i.test(header("List-Unsubscribe-Post") ?? ""),
    senderDomains: [],
  };
  for (const m of (header("List-Unsubscribe") ?? "").matchAll(/<([^>]+)>/g)) {
    const url = m[1].trim();
    if (/^https?:\/\//i.test(url) && !out.https) out.https = url;
    if (/^mailto:/i.test(url) && !out.mailto) out.mailto = url;
  }
  for (const name of ["From", "Return-Path"]) {
    const address = headerAddress(header(name));
    const domain = address ? domainOf(address) : null;
    if (domain && !out.senderDomains.includes(domain)) {
      out.senderDomains.push(domain);
    }
  }
  return out;
}

async function perform(
  parsed: Parsed,
  sendMail: (to: string) => Promise<void>,
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
    const to = mailtoAddress(parsed.mailto);
    if (to && allowedRecipient(to, parsed.senderDomains)) {
      try {
        await sendMail(to);
        return { method: "mailto", to };
      } catch {
        /* fall through */
      }
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
    `https://gmail.googleapis.com/gmail/v1/users/me/messages/${messageId}?format=metadata&metadataHeaders=List-Unsubscribe&metadataHeaders=List-Unsubscribe-Post&metadataHeaders=From&metadataHeaders=Return-Path`,
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

  return perform(parseHeaders(header), async (to) => {
    await sendGmailMessage(accessToken, {
      to,
      subject: MAILTO_SUBJECT,
      body: MAILTO_BODY,
    });
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

  return perform(parseHeaders(header), async (to) => {
    await sendGraphMessage(accessToken, {
      to,
      subject: MAILTO_SUBJECT,
      body: MAILTO_BODY,
    });
  });
}
