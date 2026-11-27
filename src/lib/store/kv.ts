import { promises as fs } from "fs";
import path from "path";
import { Redis } from "@upstash/redis";
import { pgDelete, pgDeleteMany, pgEnabled, pgGet, pgSet } from "@/lib/store/pg";

/**
 * One storage facade for every Seer memory (accounts, action memory,
 * taught senders, decision cache, personal context, mail history,
 * profile, understanding, matters). JSON documents by key.
 *
 * Backend, in order of preference:
 * - Postgres (Supabase) when POSTGRES_URL exists — durable and queryable,
 *   the system of record. During the transition it DUAL-WRITES to Redis
 *   (so a rollback loses nothing) and, on a Postgres miss, reads through
 *   to Redis and backfills — existing data migrates lazily as it's touched.
 * - Upstash Redis when only the KV integration is present.
 * - Local .data/ files otherwise (dev).
 */

const DATA_DIR =
  process.env.SEER_DATA_DIR || path.join(process.cwd(), ".data");

let redis: Redis | null | undefined;

function getRedis(): Redis | null {
  if (redis !== undefined) return redis;
  const url =
    process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
  const token =
    process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;
  redis =
    url && token
      ? new Redis({ url, token, automaticDeserialization: false })
      : null;
  return redis;
}

/** True when a durable backend (Postgres or Redis) is active. */
export function kvDurable(): boolean {
  return pgEnabled() || getRedis() !== null;
}

function fileFor(key: string) {
  const safe = key.toLowerCase().replace(/[^a-z0-9@._:-]/g, "_");
  return path.join(DATA_DIR, `${safe.replace(/:/g, "-")}.json`);
}

// ---- Redis helpers (also the transition mirror) ----------------------

async function redisGet<T>(key: string): Promise<T | null> {
  const r = getRedis();
  if (!r) return null;
  try {
    const raw = await r.get<string>(`seer:${key}`);
    return raw == null ? null : (JSON.parse(raw) as T);
  } catch (e) {
    console.error("[seer] redis get failed:", key, e instanceof Error ? e.message : e);
    return null;
  }
}

async function redisSet<T>(
  key: string,
  value: T,
  opts?: { ttlSeconds?: number },
): Promise<void> {
  const r = getRedis();
  if (!r) return;
  try {
    const raw = JSON.stringify(value);
    if (opts?.ttlSeconds) await r.set(`seer:${key}`, raw, { ex: opts.ttlSeconds });
    else await r.set(`seer:${key}`, raw);
  } catch (e) {
    console.error("[seer] redis set failed:", key, e instanceof Error ? e.message : e);
  }
}

async function fileGet<T>(key: string): Promise<T | null> {
  try {
    const raw = await fs.readFile(fileFor(key), "utf8");
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

async function fileSet<T>(key: string, value: T): Promise<void> {
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.writeFile(fileFor(key), JSON.stringify(value), "utf8");
}

// ---- Public facade ---------------------------------------------------

export async function kvGet<T>(key: string): Promise<T | null> {
  if (pgEnabled()) {
    try {
      const hit = await pgGet<T>(key);
      if (hit !== null) return hit;
      // Miss in Postgres: fall through to Redis and backfill so existing
      // data migrates the first time it's read.
      const fromRedis = await redisGet<T>(key);
      if (fromRedis !== null) {
        pgSet(key, fromRedis).catch(() => {});
        return fromRedis;
      }
      return null;
    } catch (e) {
      console.error("[seer] pg get failed, falling back:", key, e instanceof Error ? e.message : e);
      return (await redisGet<T>(key)) ?? (await fileGet<T>(key));
    }
  }
  if (getRedis()) return redisGet<T>(key);
  return fileGet<T>(key);
}

export async function kvSet<T>(
  key: string,
  value: T,
  opts?: { ttlSeconds?: number },
): Promise<void> {
  if (pgEnabled()) {
    try {
      await pgSet(key, value, opts);
      // Mirror to Redis during the transition so a rollback loses nothing.
      redisSet(key, value, opts).catch(() => {});
      return;
    } catch (e) {
      console.error("[seer] pg set failed, falling back:", key, e instanceof Error ? e.message : e);
      if (getRedis()) return redisSet(key, value, opts);
      return fileSet(key, value);
    }
  }
  if (getRedis()) return redisSet(key, value, opts);
  return fileSet(key, value);
}

export async function kvDelete(key: string): Promise<void> {
  if (pgEnabled()) {
    try {
      await pgDelete(key);
    } catch (e) {
      console.error("[seer] pg del failed:", key, e instanceof Error ? e.message : e);
    }
  }
  const r = getRedis();
  if (r) {
    try {
      await r.del(`seer:${key}`);
    } catch (e) {
      console.error("[seer] redis del failed:", key, e instanceof Error ? e.message : e);
    }
  }
  if (!pgEnabled() && !r) await fs.unlink(fileFor(key)).catch(() => {});
}

/**
 * Delete keys from every backend, including the fallbacks a failed durable
 * write may have landed in. Unlike kvDelete, a backend failure throws so
 * callers that must not leave the documents behind can abort.
 */
export async function kvPurge(keys: string[]): Promise<void> {
  if (keys.length === 0) return;
  if (pgEnabled()) await pgDeleteMany(keys);
  const r = getRedis();
  if (r) await r.del(...keys.map((key) => `seer:${key}`));
  await Promise.all(
    keys.map((key) =>
      fs.unlink(fileFor(key)).catch((e: NodeJS.ErrnoException) => {
        if (e?.code !== "ENOENT" && e?.code !== "ENOTDIR") throw e;
      }),
    ),
  );
}

/**
 * Every document stored per mailbox address. Mail accounts can be removed and
 * the address later connected by a different user, so removal purges every
 * prefix listed here; per-mailbox stores must build keys with `mailboxKey`.
 */
export const MAILBOX_KEY_PREFIXES = [
  "action-memory",
  "autonomy",
  "bluebubbles",
  "brief",
  "closed-matters",
  "decisions",
  "ea",
  "functions",
  "gmail-labels",
  "imessage",
  "inbox-snap",
  "kept-scan",
  "labels-era",
  "last-open",
  "mail-history",
  "matter-edits",
  "matter-fixes",
  "matter-order",
  "merchants",
  "people",
  "personal",
  "profile",
  "replied",
  "salesforce",
  "salesforce-app",
  "salesforce-conn",
  "sf-exemplars",
  "triage-ledger",
  "understanding",
  "waiting",
] as const;

export type MailboxKeyPrefix = (typeof MAILBOX_KEY_PREFIXES)[number];

function accountKey(accountEmail: string): string {
  return accountEmail.toLowerCase().trim();
}

export function mailboxKey(prefix: MailboxKeyPrefix, accountEmail: string): string {
  return `${prefix}:${accountKey(accountEmail)}`;
}

/** Remove every per-mailbox document for an address; throws if any delete fails. */
export async function purgeMailboxStorage(accountEmail: string): Promise<void> {
  await kvPurge(MAILBOX_KEY_PREFIXES.map((prefix) => mailboxKey(prefix, accountEmail)));
}
