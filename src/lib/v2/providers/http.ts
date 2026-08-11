/**
 * Shared provider HTTP behavior: safe reads retry with backoff on 429/5xx,
 * mutations are single-attempt, Retry-After is honored, empty 2xx bodies are
 * success, and every call is bounded by a timeout/deadline. It never logs
 * authorization headers or message bodies.
 */

import { SyncDeadlineError } from "./types";

export class ProviderHttpError extends Error {
  constructor(
    readonly status: number,
    readonly provider: string,
    message: string,
  ) {
    super(message);
    this.name = "ProviderHttpError";
  }
}

export type ProviderHttpOptions = {
  provider: string;
  maxRetries?: number;
  timeoutMs?: number;
  /** Injectable for tests; defaults to global fetch. */
  fetchImpl?: typeof fetch;
  /** Injectable sleep so tests don't wait on real backoff. */
  sleep?: (ms: number) => Promise<void>;
  /** Optional sync-slice deadline and cancellation signal. */
  deadlineMs?: number;
  signal?: AbortSignal;
};

const RETRYABLE = new Set([429, 500, 502, 503, 504]);

function backoffMs(attempt: number): number {
  return Math.min(16_000, 500 * 2 ** attempt);
}

export async function providerFetch(
  url: string,
  init: RequestInit,
  opts: ProviderHttpOptions,
): Promise<unknown> {
  const maxRetries = opts.maxRetries ?? 4;
  const timeoutMs = opts.timeoutMs ?? 15_000;
  const doFetch = opts.fetchImpl ?? fetch;
  const sleep =
    opts.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));

  let lastError: unknown;
  const method = (init.method ?? "GET").toString().toUpperCase();
  const retrySafe = method === "GET" || method === "HEAD";
  const attempts = retrySafe ? maxRetries : 0;

  for (let attempt = 0; attempt <= attempts; attempt++) {
    if (opts.signal?.aborted || (opts.deadlineMs !== undefined && Date.now() >= opts.deadlineMs)) {
      throw new SyncDeadlineError();
    }
    const controller = new AbortController();
    const callerSignal = opts.signal ?? init.signal;
    const abortFromCaller = () => controller.abort();
    callerSignal?.addEventListener("abort", abortFromCaller, { once: true });
    const remaining =
      opts.deadlineMs === undefined
        ? timeoutMs
        : Math.max(1, Math.min(timeoutMs, opts.deadlineMs - Date.now()));
    const timer = setTimeout(() => controller.abort(), remaining);
    try {
      const res = await doFetch(url, { ...init, signal: controller.signal });
      clearTimeout(timer);
      callerSignal?.removeEventListener("abort", abortFromCaller);
      if (opts.deadlineMs !== undefined && Date.now() >= opts.deadlineMs) {
        throw new SyncDeadlineError();
      }

      if (RETRYABLE.has(res.status) && attempt < attempts) {
        const retryAfter = Number(res.headers.get("retry-after"));
        await sleep(
          Number.isFinite(retryAfter) && retryAfter > 0
            ? retryAfter * 1000
            : backoffMs(attempt),
        );
        continue;
      }

      const text = await res.text();
      if (!res.ok) {
        throw new ProviderHttpError(
          res.status,
          opts.provider,
          // Truncate; never echo full provider payloads into logs/errors.
          text.slice(0, 200),
        );
      }
      // Empty 2xx body (e.g. Graph 202 on send/mutate) is success.
      return text ? (JSON.parse(text) as unknown) : null;
    } catch (err) {
      clearTimeout(timer);
      callerSignal?.removeEventListener("abort", abortFromCaller);
      lastError = err;
      if (err instanceof SyncDeadlineError) throw err;
      if (
        callerSignal?.aborted ||
        (opts.deadlineMs !== undefined && Date.now() >= opts.deadlineMs)
      ) {
        throw new SyncDeadlineError();
      }
      // A non-retryable provider error propagates immediately.
      if (err instanceof ProviderHttpError) throw err;
      if (attempt < attempts) {
        await sleep(backoffMs(attempt));
        continue;
      }
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new Error(`${opts.provider} request failed`);
}
