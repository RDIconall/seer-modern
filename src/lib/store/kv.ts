import { promises as fs } from "fs";
import path from "path";
import { Redis } from "@upstash/redis";

/**
 * One storage facade for every Seer memory (accounts, action memory,
 * taught senders, decision cache, personal context, mail history,
 * profile). JSON documents by key.
 *
 * Backend picks itself:
 * - Upstash Redis when UPSTASH_REDIS_REST_URL/TOKEN exist (Vercel
 *   Marketplace integration) — durable across serverless instances.
 * - Local .data/ files otherwise (dev, or before the integration is
 *   installed) — exactly the old behavior.
 */

const DATA_DIR =
  process.env.SEER_DATA_DIR || path.join(process.cwd(), ".data");

let redis: Redis | null | undefined;

function getRedis(): Redis | null {
  if (redis !== undefined) return redis;
  // Vercel's Upstash KV integration injects KV_REST_API_*; a manually
  // created Upstash database injects UPSTASH_REDIS_REST_*. Accept both.
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

/** True when a durable (Redis) backend is active. */
export function kvDurable(): boolean {
  return getRedis() !== null;
}

function fileFor(key: string) {
  const safe = key.toLowerCase().replace(/[^a-z0-9@._:-]/g, "_");
  return path.join(DATA_DIR, `${safe.replace(/:/g, "-")}.json`);
}

export async function kvGet<T>(key: string): Promise<T | null> {
  const r = getRedis();
  if (r) {
    try {
      const raw = await r.get<string>(`seer:${key}`);
      return raw == null ? null : (JSON.parse(raw) as T);
    } catch (e) {
      console.error("[seer] kv get failed:", key, e instanceof Error ? e.message : e);
      return null;
    }
  }
  try {
    const raw = await fs.readFile(fileFor(key), "utf8");
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

export async function kvSet<T>(
  key: string,
  value: T,
  opts?: { ttlSeconds?: number },
): Promise<void> {
  const r = getRedis();
  if (r) {
    try {
      const raw = JSON.stringify(value);
      if (opts?.ttlSeconds) {
        await r.set(`seer:${key}`, raw, { ex: opts.ttlSeconds });
      } else {
        await r.set(`seer:${key}`, raw);
      }
      return;
    } catch (e) {
      console.error("[seer] kv set failed:", key, e instanceof Error ? e.message : e);
      return;
    }
  }
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.writeFile(fileFor(key), JSON.stringify(value), "utf8");
}

export async function kvDelete(key: string): Promise<void> {
  const r = getRedis();
  if (r) {
    try {
      await r.del(`seer:${key}`);
    } catch (e) {
      console.error("[seer] kv del failed:", key, e instanceof Error ? e.message : e);
    }
    return;
  }
  await fs.unlink(fileFor(key)).catch(() => {});
}

/** Normalized account key fragment shared by all per-account stores. */
export function accountKey(accountEmail: string): string {
  return accountEmail.toLowerCase().trim();
}
