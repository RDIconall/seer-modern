/**
 * Who may use Seer. This is an organization gate, not a named-user list:
 * anyone with an @rditrials.com mailbox can sign in. Personal Gmail, other
 * companies, and spoofed hostnames are out.
 */

export const ORG_DOMAIN = "rditrials.com";

export function isAllowedOrgEmail(email: string | null | undefined): boolean {
  if (!email) return false;
  const trimmed = email.trim().toLowerCase();
  const at = trimmed.lastIndexOf("@");
  if (at <= 0 || at === trimmed.length - 1) return false;
  return trimmed.slice(at + 1) === ORG_DOMAIN;
}
