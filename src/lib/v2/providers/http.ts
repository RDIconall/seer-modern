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

/**
 * A response body would exceed the caller's byte budget. Raised before the
 * body is parsed and never retried.
 */
export class ProviderResponseTooLargeError extends Error {
  constructor(
    readonly provider: string,
    readonly limitBytes: number,
  ) {
    super(`${provider} response exceeds ${limitBytes} bytes`);
    this.name = "ProviderResponseTooLargeError";
  }
}

/**
 * Raw body bytes the caller may still read. Shared across calls (and retry
 * attempts) so one budget can bound a multi-page load; decremented in place.
 */
export type ResponseByteBudget = { remaining: number };

export type ProviderHttpOptions = {
  provider: string;
  maxRetries?: number;
  timeoutMs?: number;
  /** Injectable for tests; defaults to global fetch. */
  fetchImpl?: typeof fetch;
  /** Injectable sleep so tests don't wait on real backoff. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  /** Optional sync-slice deadline and cancellation signal. */
  deadlineMs?: number;
  signal?: AbortSignal;
  responseBudget?: ResponseByteBudget;
};

const RETRYABLE = new Set([429, 500, 502, 503, 504]);
const RETRY_HEADROOM_MS = 25;

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
    opts.sleep ??
    ((ms: number) =>
      new Promise<void>((resolve) => {
        setTimeout(resolve, ms);
      }));

  let lastError: unknown;
  const method = (init.method ?? "GET").toString().toUpperCase();
  const retrySafe = method === "GET" || method === "HEAD";
  const attempts = retrySafe ? maxRetries : 0;
  const callerSignal = opts.signal ?? init.signal ?? undefined;

  for (let attempt = 0; attempt <= attempts; attempt++) {
    if (callerSignal?.aborted || (opts.deadlineMs !== undefined && Date.now() >= opts.deadlineMs)) {
      throw new SyncDeadlineError();
    }
    const controller = new AbortController();
    const abortFromCaller = () => controller.abort();
    callerSignal?.addEventListener("abort", abortFromCaller, { once: true });
    const remaining =
      opts.deadlineMs === undefined
        ? timeoutMs
        : Math.max(1, Math.min(timeoutMs, opts.deadlineMs - Date.now()));
    const timer = setTimeout(() => controller.abort(), remaining);
    try {
      const res = await doFetch(url, { ...init, signal: controller.signal });
      if (opts.deadlineMs !== undefined && Date.now() >= opts.deadlineMs) {
        throw new SyncDeadlineError();
      }

      const text = await responseText(
        res,
        controller.signal,
        callerSignal,
        opts.deadlineMs,
        opts.responseBudget,
        opts.provider,
      );
      if (RETRYABLE.has(res.status) && attempt < attempts) {
        const retryAfter = Number(res.headers.get("retry-after"));
        const requestedDelay =
          Number.isFinite(retryAfter) && retryAfter > 0
            ? retryAfter * 1000
            : backoffMs(attempt);
        const delay = retryDelay(requestedDelay, opts.deadlineMs);
        await abortableSleep(sleep, delay, callerSignal, opts.deadlineMs);
        continue;
      }

      if (!res.ok) {
        throw new ProviderHttpError(
          res.status,
          opts.provider,
          // Truncate; never echo full provider payloads into logs/errors.
          text.slice(0, 200),
        );
      }
      // Empty 2xx body (e.g. Graph 202 on send/mutate) is success.
      const parsed = text ? (JSON.parse(text) as unknown) : null;
      if (opts.deadlineMs !== undefined && Date.now() >= opts.deadlineMs) {
        throw new SyncDeadlineError();
      }
      return parsed;
    } catch (err) {
      clearTimeout(timer);
      callerSignal?.removeEventListener("abort", abortFromCaller);
      lastError = err;
      if (err instanceof SyncDeadlineError) throw err;
      if (err instanceof ProviderResponseTooLargeError) throw err;
      if (
        callerSignal?.aborted ||
        (opts.deadlineMs !== undefined && Date.now() >= opts.deadlineMs)
      ) {
        throw new SyncDeadlineError();
      }
      // A non-retryable provider error propagates immediately.
      if (err instanceof ProviderHttpError) throw err;
      if (attempt < attempts) {
        const delay = retryDelay(backoffMs(attempt), opts.deadlineMs);
        await abortableSleep(sleep, delay, callerSignal, opts.deadlineMs);
        continue;
      }
    } finally {
      clearTimeout(timer);
      callerSignal?.removeEventListener("abort", abortFromCaller);
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new Error(`${opts.provider} request failed`);
}

function retryDelay(requestedMs: number, deadlineMs: number | undefined): number {
  if (deadlineMs === undefined) return requestedMs;
  const remaining = deadlineMs - Date.now();
  if (remaining <= RETRY_HEADROOM_MS) throw new SyncDeadlineError();
  return Math.min(requestedMs, remaining - RETRY_HEADROOM_MS);
}

async function abortableSleep(
  sleep: (ms: number, signal?: AbortSignal) => Promise<void>,
  ms: number,
  signal: AbortSignal | undefined,
  deadlineMs: number | undefined,
): Promise<void> {
  if (signal?.aborted || (deadlineMs !== undefined && Date.now() >= deadlineMs)) {
    throw new SyncDeadlineError();
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  try {
    await Promise.race([
      sleep(ms, signal),
      new Promise<never>((_, reject) => {
        onAbort = () => reject(new SyncDeadlineError());
        signal?.addEventListener("abort", onAbort, { once: true });
        if (deadlineMs !== undefined) {
          timer = setTimeout(() => reject(new SyncDeadlineError()), Math.max(1, deadlineMs - Date.now()));
        }
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
    if (onAbort) signal?.removeEventListener("abort", onAbort);
  }
}

async function responseText(
  res: Response,
  signal: AbortSignal,
  callerSignal: AbortSignal | undefined,
  deadlineMs: number | undefined,
  budget: ResponseByteBudget | undefined,
  provider: string,
): Promise<string> {
  if (signal.aborted) {
    if (callerSignal?.aborted || (deadlineMs !== undefined && Date.now() >= deadlineMs)) {
      throw new SyncDeadlineError();
    }
  }
  return new Promise<string>((resolve, reject) => {
    let cancelBody: (() => void) | undefined;
    const onAbort = () => {
      signal.removeEventListener("abort", onAbort);
      cancelBody?.();
      if (callerSignal?.aborted || (deadlineMs !== undefined && Date.now() >= deadlineMs)) {
        reject(new SyncDeadlineError());
      } else {
        reject(new Error("provider response body timed out"));
      }
    };
    signal.addEventListener("abort", onAbort, { once: true });
    const body = budget
      ? boundedText(res, budget, provider, (cancel) => {
          cancelBody = cancel;
        })
      : res.text();
    body.then(
      (text) => {
        signal.removeEventListener("abort", onAbort);
        resolve(text);
      },
      (error) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

/**
 * Read the body without ever holding more than the remaining budget: refuse
 * an over-budget Content-Length before reading, and cancel the stream as soon
 * as the bytes read pass the budget (chunked or mislabelled responses).
 */
async function boundedText(
  res: Response,
  budget: ResponseByteBudget,
  provider: string,
  onCancel: (cancel: () => void) => void,
): Promise<string> {
  const limit = budget.remaining;
  const declared = Number(res.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > limit) {
    await res.body?.cancel().catch(() => undefined);
    throw new ProviderResponseTooLargeError(provider, limit);
  }
  if (!res.body) return "";
  const reader = res.body.getReader();
  onCancel(() => {
    reader.cancel().catch(() => undefined);
  });
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    budget.remaining -= value.byteLength;
    if (budget.remaining < 0) {
      await reader.cancel().catch(() => undefined);
      throw new ProviderResponseTooLargeError(provider, limit);
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}
