import { createHash, timingSafeEqual } from "node:crypto";

/** Shared secret for the GCP Pub/Sub push URL (`?token=` / Bearer / header). */
export const GMAIL_PUSH_TOKEN_ENV = "GMAIL_PUBSUB_VERIFICATION_TOKEN";
/** Audience claimed by a Google OIDC token on the Authorization header. */
export const GMAIL_PUSH_AUDIENCE_ENV = "GMAIL_PUSH_AUDIENCE";

const TOKEN_HEADER = "x-seer-pubsub-token";

export type GmailPushAuthResult = { ok: boolean; reason?: string };

function configuredSecret(name: string): string {
  return (process.env[name] ?? "").trim();
}

function secretsEqual(provided: string, expected: string): boolean {
  const left = createHash("sha256").update(provided).digest();
  const right = createHash("sha256").update(expected).digest();
  return timingSafeEqual(left, right);
}

function bearerToken(request: Request): string | null {
  const header = request.headers.get("authorization");
  if (!header) return null;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match?.[1]?.trim() || null;
}

function looksLikeJwt(value: string): boolean {
  const parts = value.split(".");
  return parts.length === 3 && parts.every((part) => part.length > 0);
}

function providedSharedSecret(request: Request): string | null {
  const url = new URL(request.url);
  const fromQuery = url.searchParams.get("token")?.trim();
  if (fromQuery) return fromQuery;
  const fromHeader = request.headers.get(TOKEN_HEADER)?.trim();
  if (fromHeader) return fromHeader;
  const fromBearer = bearerToken(request);
  if (fromBearer && !looksLikeJwt(fromBearer)) return fromBearer;
  return null;
}

async function googleOidcAuthorized(
  token: string,
  audience: string,
): Promise<boolean> {
  const url = new URL("https://oauth2.googleapis.com/tokeninfo");
  url.searchParams.set("id_token", token);
  const response = await fetch(url, { cache: "no-store" });
  if (!response.ok) return false;
  const body = (await response.json().catch(() => null)) as {
    aud?: string;
    iss?: string;
    exp?: string | number;
  } | null;
  if (!body) return false;
  if (body.aud !== audience) return false;
  if (body.iss !== "https://accounts.google.com" && body.iss !== "accounts.google.com") {
    return false;
  }
  const exp = Number(body.exp);
  if (!Number.isFinite(exp) || exp * 1000 < Date.now() - 30_000) return false;
  return true;
}

/**
 * Gmail Pub/Sub push auth. Unsigned POSTs stay accepted until a token or
 * OIDC audience is configured, so the current GCP subscription keeps
 * filling the inbox. Once either env is set, unsigned requests are denied.
 */
export async function gmailPushAuthorized(
  request: Request,
): Promise<GmailPushAuthResult> {
  const expectedToken = configuredSecret(GMAIL_PUSH_TOKEN_ENV);
  const audience = configuredSecret(GMAIL_PUSH_AUDIENCE_ENV);
  if (!expectedToken && !audience) return { ok: true };

  if (expectedToken) {
    const provided = providedSharedSecret(request);
    if (provided && secretsEqual(provided, expectedToken)) return { ok: true };
    const bearer = bearerToken(request);
    if (bearer && !looksLikeJwt(bearer) && secretsEqual(bearer, expectedToken)) {
      return { ok: true };
    }
  }

  if (audience) {
    const bearer = bearerToken(request);
    if (bearer && looksLikeJwt(bearer) && (await googleOidcAuthorized(bearer, audience))) {
      return { ok: true };
    }
  }

  return { ok: false, reason: "unauthorized" };
}
