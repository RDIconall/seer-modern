import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type { AccountId } from "@/lib/v2/db/types";

/** Minimum gap between wakes for one account — providers burst duplicates. */
export const WAKE_DEDUPE_MS = 45_000;

export function publicAppUrl(): string {
  const raw = process.env.AUTH_URL ?? process.env.VERCEL_URL;
  if (!raw) throw new Error("AUTH_URL is required for mail push webhooks");
  return raw.startsWith("http") ? raw.replace(/\/$/, "") : `https://${raw}`;
}

export function webhookPepper(): string {
  const pepper = process.env.SEER_WEBHOOK_PEPPER ?? process.env.CRON_SECRET;
  if (!pepper) {
    throw new Error("SEER_WEBHOOK_PEPPER (or CRON_SECRET) is required for push");
  }
  return pepper;
}

export function graphClientState(accountId: AccountId): string {
  return createHmac("sha256", webhookPepper())
    .update(`graph:${accountId}`)
    .digest("hex");
}

export function graphClientStateHash(accountId: AccountId): string {
  return createHash("sha256").update(graphClientState(accountId)).digest("hex");
}

const GRAPH_CLIENT_STATE_SHAPE = /^[0-9a-f]{64}$/i;
const GRAPH_SUBSCRIPTION_ID_SHAPE = /^[A-Za-z0-9-]{1,128}$/;

/**
 * Cheap shape check run before any database work: graphClientState is always
 * 64 hex characters, so anything else can never match and must not cost a
 * subscription lookup.
 */
export function isPlausibleGraphClientState(value: unknown): value is string {
  return typeof value === "string" && GRAPH_CLIENT_STATE_SHAPE.test(value);
}

export function isPlausibleGraphSubscriptionId(
  value: unknown,
): value is string {
  return typeof value === "string" && GRAPH_SUBSCRIPTION_ID_SHAPE.test(value);
}

export function clientStateMatches(
  accountId: AccountId,
  provided: string | null | undefined,
): boolean {
  if (!provided) return false;
  const expected = Buffer.from(graphClientState(accountId));
  const got = Buffer.from(provided);
  if (expected.length !== got.length) return false;
  return timingSafeEqual(expected, got);
}

export function gmailPubSubTopic(): string | null {
  const topic = process.env.GMAIL_PUBSUB_TOPIC?.trim();
  return topic || null;
}
