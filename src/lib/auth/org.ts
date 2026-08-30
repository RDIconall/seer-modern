/**
 * Who may use Seer. This is an organization gate, not a named-user list:
 * anyone with an @rditrials.com mailbox can sign in, and Vercel holds no
 * roster of people.
 *
 * The organization is not the whole story, though. This desk was a personal
 * mailbox before it was a company's, and gating on one hardcoded domain locked
 * the owner's own Gmail out of their own mail client — sign-in, account
 * linking and the v3 client all read this one function. So the deployment can
 * name extra domains (an alias domain of the same company) or extra addresses,
 * and by default it names neither: with nothing configured, only the org
 * domain passes.
 */

export const ORG_DOMAIN = "rditrials.com";

/** Extra addresses, comma-separated. `SEER_ALLOWED_EMAILS=you@gmail.com` */
export const EMAILS_ENV = "SEER_ALLOWED_EMAILS";

/**
 * The single-address gate this app used before the organization existed. The
 * code that read it was removed, but a deployment that still carries it in its
 * environment is still naming its owner, so it is honored — one address, and
 * the same one that used to be the only address allowed in. Setting
 * `SEER_ALLOWED_EMAILS` supersedes it and it can then be deleted.
 */
export const LEGACY_EMAIL_ENV = "ALLOWED_EMAIL";

/** Extra domains, comma-separated. `SEER_ALLOWED_EMAIL_DOMAINS=rdi.example` */
export const DOMAINS_ENV = "SEER_ALLOWED_EMAIL_DOMAINS";

function configured(name: string): string[] {
  return (process.env[name] ?? "")
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);
}

function parse(
  email: string | null | undefined,
): { address: string; domain: string } | null {
  if (!email) return null;
  const address = email.trim().toLowerCase();
  if (address.length === 0 || /\s/.test(address)) return null;
  const at = address.lastIndexOf("@");
  if (at <= 0 || at === address.length - 1) return null;
  return { address, domain: address.slice(at + 1) };
}

/** Every domain that may sign in, the organization's first. */
export function allowedDomains(): string[] {
  const extra = configured(DOMAINS_ENV).map((domain) =>
    domain.replace(/^@/, ""),
  );
  return [...new Set([ORG_DOMAIN, ...extra])];
}

/** Addresses allowed on their own, outside any allowed domain. */
export function allowedEmails(): string[] {
  return [
    ...new Set([...configured(EMAILS_ENV), ...configured(LEGACY_EMAIL_ENV)]),
  ];
}

export function isAllowedOrgEmail(email: string | null | undefined): boolean {
  const parsed = parse(email);
  if (!parsed) return false;
  if (allowedDomains().includes(parsed.domain)) return true;
  return allowedEmails().includes(parsed.address);
}

/**
 * Why an address was refused, for the logs and for the error a linked account
 * raises. "Access Denied" alone cannot be acted on: the address that was
 * refused, and the name of the setting that would admit it, are the whole fix.
 */
export function describeAccessRefusal(
  email: string | null | undefined,
): string {
  const parsed = parse(email);
  if (!parsed) return "the account carries no usable email address";
  const domains = allowedDomains()
    .map((domain) => `@${domain}`)
    .join(", ");
  const named =
    allowedEmails().length > 0
      ? ` nor one of the ${allowedEmails().length} address(es) in ${EMAILS_ENV}`
      : "";
  return `${parsed.address} is not ${domains}${named} — add it to ${EMAILS_ENV} to let it in`;
}
