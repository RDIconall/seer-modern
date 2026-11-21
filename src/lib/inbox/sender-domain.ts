import { getDomain } from "tldts";

export const FREEMAIL =
  /^(gmail|googlemail|outlook|hotmail|live|yahoo|ymail|aol|icloud|me|msn|proton|protonmail|comcast|sbcglobal|att|verizon)\./;

/**
 * The registrable domain of an address, per the Public Suffix List
 * (private suffixes included): alerts@mail.acme.co.uk → "acme.co.uk",
 * alerts@alpha.blogspot.com → "alpha.blogspot.com". Empty when the host
 * has no registrable part (a bare suffix, an IP literal, a single label).
 */
export function registrableDomain(email: string | undefined): string {
  const host = (email ?? "").split("@").pop()?.trim().toLowerCase() ?? "";
  if (!host) return "";
  return getDomain(host, { allowPrivateDomains: true }) ?? "";
}

/**
 * Who an automated notice is from, for collapsing several into one matter:
 * the registrable domain, so one company's subdomains share a key and two
 * companies under the same public suffix never do. Freemail and hosts with
 * no registrable domain are anyone's, so they key on the exact address.
 */
export function automatedSenderKey(email: string | undefined): string {
  const address = (email ?? "").trim().toLowerCase();
  if (!address.includes("@")) return "";
  const domain = registrableDomain(address);
  if (!domain || FREEMAIL.test(domain)) return address;
  return domain;
}

/**
 * The threads a collapsed automated matter may archive when it is closed.
 * Every row on the card must come from one sender key; a card that mixes
 * senders archives nothing, and a stored thread id with no row behind it
 * is never archived.
 */
export function automatedCloseThreadIds(matter: {
  threadIds?: string[];
  emails?: { threadId?: string; fromEmail?: string }[];
}): { threadIds: string[]; mixed: boolean } {
  const rows = matter.emails ?? [];
  const keys = new Set(rows.map((row) => automatedSenderKey(row.fromEmail)));
  if (rows.length === 0 || keys.size !== 1 || keys.has("")) {
    return { threadIds: [], mixed: rows.length > 0 };
  }
  const listed = new Set(
    rows.map((row) => row.threadId).filter((t): t is string => Boolean(t)),
  );
  return {
    threadIds: [...new Set(matter.threadIds ?? [])].filter((t) => listed.has(t)),
    mixed: false,
  };
}

export const AUTOMATED_MATTER_PREFIX = "read:auto:";

export function isAutomatedMatterId(id: string): boolean {
  return id.startsWith(AUTOMATED_MATTER_PREFIX);
}
