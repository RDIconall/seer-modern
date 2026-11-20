/**
 * Whether a message was written by the mailbox owner. The From header is
 * whatever the sender typed, so it never decides this on its own: the provider
 * has to file the message as sent, or the receiving server has to report that
 * the From domain authenticated.
 */

type Header = { name: string; value: string };

/** Gmail's receiving MX stamps its own result first, above anything the sender wrote. */
const GMAIL_AUTHSERV_ID = "mx.google.com";

function domainOf(email: string): string {
  const at = email.lastIndexOf("@");
  return at < 0 ? "" : email.slice(at + 1).trim().toLowerCase();
}

function stripComments(value: string): string {
  let out = "";
  let depth = 0;
  for (const ch of value) {
    if (ch === "(") depth += 1;
    else if (ch === ")") depth = Math.max(0, depth - 1);
    else if (depth === 0) out += ch;
  }
  return out;
}

/**
 * True when Gmail's own Authentication-Results says DMARC passed for the From
 * domain. Only the topmost Authentication-Results header is read: a sender can
 * append as many forged ones below it as they like.
 */
export function gmailFromDomainAuthenticated(
  headers: Header[] | undefined,
  fromEmail: string,
): boolean {
  const domain = domainOf(fromEmail);
  if (!domain) return false;
  const first = (headers ?? []).find(
    (h) => h.name.toLowerCase() === "authentication-results",
  );
  if (!first) return false;
  const [authserv, ...results] = stripComments(first.value).split(";");
  if (authserv.trim().split(/\s+/)[0]?.toLowerCase() !== GMAIL_AUTHSERV_ID) {
    return false;
  }
  return results.some((result) => {
    const r = result.trim();
    if (!/^dmarc\s*=\s*pass(\s|$)/i.test(r)) return false;
    const from = r.match(/(?:^|\s)header\.from\s*=\s*"?([^\s"]+)"?/i)?.[1];
    return from?.toLowerCase() === domain;
  });
}

/** Gmail: filed under SENT, or the From domain authenticated on arrival. */
export function gmailMarksFromSelf(
  labelIds: string[] | undefined,
  headers: Header[] | undefined,
  fromEmail: string,
): boolean {
  if ((labelIds ?? []).includes("SENT")) return true;
  return gmailFromDomainAuthenticated(headers, fromEmail);
}

/** The owner's own message: the provider vouched for it AND it is from this mailbox. */
export function isOwnMessage(
  message: { fromEmail: string; fromSelf?: boolean },
  accountEmail: string,
): boolean {
  return (
    message.fromSelf === true &&
    message.fromEmail.toLowerCase().trim() === accountEmail.toLowerCase().trim()
  );
}
