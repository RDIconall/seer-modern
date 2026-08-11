import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { cookies } from "next/headers";
import { kvGet, kvSet } from "@/lib/store/kv";

export type AccountLinkProvider = "google" | "microsoft-entra-id";

export type AccountLinkPayload = {
  v: 1;
  ownerUserId: string;
  ownerEmail: string;
  provider: AccountLinkProvider;
  nonce: string;
  exp: number;
  accountId?: string;
};

type LinkStateResult =
  | { status: "none" }
  | { status: "invalid" }
  | { status: "valid"; payload: AccountLinkPayload };

export const ACCOUNT_LINK_COOKIE = "seer_account_link_state";
const MAX_AGE_SECONDS = 10 * 60;

function secret(): string {
  if (!process.env.AUTH_SECRET) {
    throw new Error("AUTH_SECRET is required for account linking");
  }
  return process.env.AUTH_SECRET;
}

function encode(value: string): string {
  return Buffer.from(value, "utf8").toString("base64url");
}

function decode(value: string): string | null {
  try {
    return Buffer.from(value, "base64url").toString("utf8");
  } catch {
    return null;
  }
}

function signature(value: string): string {
  return createHmac("sha256", secret()).update(value).digest("base64url");
}

export function signAccountLinkState(
  input: Omit<AccountLinkPayload, "v" | "nonce" | "exp"> & {
    nonce?: string;
    exp?: number;
  },
  now = Date.now(),
): string {
  const payload: AccountLinkPayload = {
    v: 1,
    ownerUserId: input.ownerUserId,
    ownerEmail: input.ownerEmail.toLowerCase(),
    provider: input.provider,
    nonce: input.nonce ?? randomBytes(24).toString("base64url"),
    exp: input.exp ?? now + MAX_AGE_SECONDS * 1000,
    ...(input.accountId ? { accountId: input.accountId } : {}),
  };
  const encoded = encode(JSON.stringify(payload));
  return `${encoded}.${signature(encoded)}`;
}

export function consumeSignedAccountLinkState(
  raw: string,
  provider: AccountLinkProvider,
  usedNonces: Set<string>,
  now = Date.now(),
): AccountLinkPayload | null {
  const [encoded, supplied] = raw.split(".");
  if (!encoded || !supplied) return null;
  const expected = signature(encoded);
  const expectedBuffer = Buffer.from(expected);
  const suppliedBuffer = Buffer.from(supplied);
  if (
    expectedBuffer.length !== suppliedBuffer.length ||
    !timingSafeEqual(expectedBuffer, suppliedBuffer)
  ) {
    return null;
  }
  const decoded = decode(encoded);
  if (!decoded) return null;
  let payload: AccountLinkPayload;
  try {
    payload = JSON.parse(decoded) as AccountLinkPayload;
  } catch {
    return null;
  }
  if (
    payload.v !== 1 ||
    payload.provider !== provider ||
    !payload.ownerUserId ||
    !payload.ownerEmail ||
    !payload.nonce ||
    !Number.isInteger(payload.exp) ||
    payload.exp <= now ||
    usedNonces.has(payload.nonce)
  ) {
    return null;
  }
  usedNonces.add(payload.nonce);
  return payload;
}

export async function beginAccountLinkState(input: {
  ownerUserId: string;
  ownerEmail: string;
  provider: AccountLinkProvider;
  accountId?: string;
}): Promise<void> {
  const raw = signAccountLinkState(input);
  const jar = await cookies();
  jar.set(ACCOUNT_LINK_COOKIE, raw, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    maxAge: MAX_AGE_SECONDS,
    path: "/",
  });
}

export async function consumeAccountLinkState(
  provider: AccountLinkProvider,
): Promise<LinkStateResult> {
  const jar = await cookies();
  const raw = jar.get(ACCOUNT_LINK_COOKIE)?.value;
  if (!raw) return { status: "none" };
  // Consume the browser copy before validation so a callback cannot reuse it.
  jar.delete(ACCOUNT_LINK_COOKIE);

  const encoded = raw.split(".")[0];
  const decoded = encoded ? decode(encoded) : null;
  let nonce: string | null = null;
  if (decoded) {
    try {
      nonce = (JSON.parse(decoded) as { nonce?: string }).nonce ?? null;
    } catch {
      nonce = null;
    }
  }
  if (!nonce) return { status: "invalid" };

  const usedKey = `oauth-link-used:${nonce}`;
  if (await kvGet<boolean>(usedKey)) return { status: "invalid" };
  const payload = consumeSignedAccountLinkState(raw, provider, new Set());
  if (!payload) return { status: "invalid" };
  await kvSet(usedKey, true, { ttlSeconds: MAX_AGE_SECONDS });
  return { status: "valid", payload };
}
