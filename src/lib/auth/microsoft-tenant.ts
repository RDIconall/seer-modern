/**
 * Which Microsoft logins are this organization's.
 *
 * Entra's `email` claim is a free-text profile attribute that any directory
 * admin can set to any address, and the multi-tenant `common` endpoint
 * accepts users from every directory. So the address Seer signs someone in
 * as is the username (`preferred_username`) of a token issued by the one
 * tenant named in `AUTH_MICROSOFT_ENTRA_ID_ISSUER`: inside that tenant a
 * username can only be on one of its verified domains. Without a tenant id in
 * the issuer there is no directory to hold the username to, and Microsoft
 * sign-in is refused.
 */

export const MICROSOFT_ISSUER_ENV = "AUTH_MICROSOFT_ENTRA_ID_ISSUER";

const LOGIN_ORIGIN = "https://login.microsoftonline.com";
const TENANT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** The configured tenant id, or null when the issuer does not name one. */
export function microsoftTenantId(): string | null {
  const issuer = process.env[MICROSOFT_ISSUER_ENV]?.trim();
  if (!issuer) return null;
  let url: URL;
  try {
    url = new URL(issuer);
  } catch {
    return null;
  }
  if (url.origin !== LOGIN_ORIGIN || url.search || url.hash) return null;
  const segments = url.pathname.split("/").filter(Boolean);
  if (segments.length !== 2 || segments[1] !== "v2.0") return null;
  const tenant = segments[0].toLowerCase();
  return TENANT_ID.test(tenant) ? tenant : null;
}

export function microsoftIssuerFor(tenant: string): string {
  return `${LOGIN_ORIGIN}/${tenant}/v2.0`;
}

export type MicrosoftIdentity =
  | { ok: true; tenant: string; username: string }
  | { ok: false; reason: string };

function claim(profile: unknown, name: string): string | null {
  if (!profile || typeof profile !== "object") return null;
  const value = (profile as Record<string, unknown>)[name];
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * The organization username carried by validated Entra ID token claims.
 * The `email` claim is never read.
 */
export function microsoftIdentity(profile: unknown): MicrosoftIdentity {
  const tenant = microsoftTenantId();
  if (!tenant) {
    return {
      ok: false,
      reason: `${MICROSOFT_ISSUER_ENV} does not name the organization's Entra tenant id (${microsoftIssuerFor("<tenant-id>")}), so Microsoft sign-in is off`,
    };
  }
  const tid = claim(profile, "tid")?.toLowerCase() ?? null;
  const iss = claim(profile, "iss")?.toLowerCase() ?? null;
  if (tid !== tenant || iss !== microsoftIssuerFor(tenant)) {
    return {
      ok: false,
      reason: `the Microsoft token was issued by tenant ${tid ?? "(none)"}, not ${tenant}`,
    };
  }
  const username = claim(profile, "preferred_username")?.toLowerCase() ?? null;
  if (!username) {
    return { ok: false, reason: "the Microsoft token carries no username" };
  }
  return { ok: true, tenant, username };
}

/** The address a Microsoft login is known by, or null when it is not the organization's. */
export function microsoftUsername(profile: unknown): string | null {
  const identity = microsoftIdentity(profile);
  return identity.ok ? identity.username : null;
}
