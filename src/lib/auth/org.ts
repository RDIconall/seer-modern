/**
 * Who may use Seer. This is an organization gate, not a named-user list:
 * anyone with an @rditrials.com mailbox can sign in, and Vercel holds no
 * roster of people.
 *
 * The organization is not the whole story, though. This desk was a personal
 * mailbox before it was a company's, and gating on one hardcoded domain locked
 * the owner's own Gmail out of their own mail client — sign-in, account
 * linking and the v3 client all read this one function. So that mailbox is
 * named below, and a deployment can name further addresses or an alias domain
 * of the same company without a code change.
 */

export const ORG_DOMAIN = "rditrials.com";

/**
 * The desk's own mailbox, allowed by name.
 *
 * Seer was this Gmail's mail client before it was the company's, and it is the
 * account the app is used and developed against, so it is named in the code
 * rather than left to an environment variable that a redeploy can lose or a
 * dashboard edit can drop. This repository is public, so this address is
 * public with it; move it to `SEER_ALLOWED_EMAILS` to keep it out of git.
 */
export const OWNER_EMAIL = "cpa2002@gmail.com";

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
    ...new Set([
      OWNER_EMAIL,
      ...configured(EMAILS_ENV),
      ...configured(LEGACY_EMAIL_ENV),
    ]),
  ];
}

export function isAllowedOrgEmail(email: string | null | undefined): boolean {
  const parsed = parse(email);
  if (!parsed) return false;
  if (allowedDomains().includes(parsed.domain)) return true;
  return allowedEmails().includes(parsed.address);
}

/** Entra's tenant for personal Microsoft accounts (outlook.com, live.com, …). */
export const MICROSOFT_CONSUMER_TENANT = "9188040d-6c67-4c5b-b112-36a304b66dad";

type ProviderClaims = {
  email?: unknown;
  email_verified?: unknown;
  hd?: unknown;
  tid?: unknown;
};

/**
 * Whether a provider login proves the right to the address it carries, not
 * just that the address ends in an allowed domain. Anyone can register a
 * personal Google or Microsoft account on an existing company address, and it
 * outlives their employment, so a domain match only counts when the provider
 * says the account is managed by the organization: Google's `hd` names the
 * Workspace that owns it, and a personal Microsoft account signs in from the
 * consumer tenant. Named addresses are trusted by address and need only a
 * verified email. Returns why the login is refused, or null to admit it.
 */
export function describeProviderSignInRefusal(
  provider: string | null | undefined,
  claims: unknown,
): string | null {
  const profile = (claims ?? {}) as ProviderClaims;
  const parsed = parse(
    typeof profile.email === "string" ? profile.email : undefined,
  );
  if (!parsed) return "the account carries no usable email address";
  if (!isAllowedOrgEmail(parsed.address)) {
    return describeAccessRefusal(parsed.address);
  }
  const named = allowedEmails().includes(parsed.address);
  if (provider === "google") {
    if (profile.email_verified !== true && profile.email_verified !== "true") {
      return `Google has not verified ${parsed.address}`;
    }
    if (named) return null;
    const hd =
      typeof profile.hd === "string" ? profile.hd.trim().toLowerCase() : "";
    if (!hd || !allowedDomains().includes(hd)) {
      return `${parsed.address} is not a Google Workspace account of ${allowedDomains().join(", ")} (hosted domain: ${hd || "none"})`;
    }
    return null;
  }
  if (provider === "microsoft-entra-id") {
    if (named) return null;
    const tid = typeof profile.tid === "string" ? profile.tid.toLowerCase() : "";
    if (!tid || tid === MICROSOFT_CONSUMER_TENANT) {
      return `${parsed.address} signed in with a personal Microsoft account, not the organization's directory`;
    }
    return null;
  }
  return `${provider ?? "an unknown provider"} cannot prove organization membership`;
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
  return `${parsed.address} is not ${domains} and is not one of the ${allowedEmails().length} address(es) Seer allows by name — add it to ${EMAILS_ENV} to let it in`;
}
