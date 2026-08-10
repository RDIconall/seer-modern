/**
 * Shared provider HTTP behavior: retries with backoff on 429/5xx, honors
 * Retry-After, treats an empty 2xx body as success, bounds every call with a
 * timeout, and surfaces structured provider errors. It never logs authorization
 * headers or message bodies.
 */

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
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await doFetch(url, { ...init, signal: controller.signal });
      clearTimeout(timer);

      if (RETRYABLE.has(res.status) && attempt < maxRetries) {
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
      lastError = err;
      // A non-retryable provider error propagates immediately.
      if (err instanceof ProviderHttpError) throw err;
      if (attempt < maxRetries) {
        await sleep(backoffMs(attempt));
        continue;
      }
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new Error(`${opts.provider} request failed`);
}
