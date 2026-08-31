/**
 * Fan-out for background work that must not share a serverless time budget.
 * Vercel cron hits one URL; that dispatcher starts one invocation per mailbox
 * so a 16k inbox cannot stall a 14-item desk, and fifty company mailboxes
 * each get their own 250s pipe.
 */

export type AccountRef = { id: string; email: string };

export type FanOutResult<T> = {
  email: string;
  ok: boolean;
  result?: T;
  error?: string;
};

export function cronOrigin(
  env: { AUTH_URL?: string; VERCEL_URL?: string } = {
    AUTH_URL: process.env.AUTH_URL,
    VERCEL_URL: process.env.VERCEL_URL,
  },
): string | null {
  const raw = env.AUTH_URL ?? env.VERCEL_URL;
  if (!raw?.trim()) return null;
  return raw.startsWith("http") ? raw.replace(/\/$/, "") : `https://${raw}`;
}

export function accountWorkerUrl(
  origin: string,
  path: string,
  accountId: string,
  extra: Record<string, string> = {},
): string {
  const url = new URL(path, origin.endsWith("/") ? origin : `${origin}/`);
  url.searchParams.set("accountId", accountId);
  for (const [key, value] of Object.entries(extra)) {
    if (value) url.searchParams.set(key, value);
  }
  return url.toString();
}

/**
 * When the app has a public origin, each account is a separate HTTP invocation
 * (its own lambda, memory, and maxDuration). Without one — tests and local
 * dev — accounts still run in parallel in-process so they cannot queue.
 */
export async function fanOutPerAccount<T>(options: {
  accounts: AccountRef[];
  path: string;
  searchParams?: Record<string, string>;
  authorization: string | null;
  origin?: string | null;
  runLocal: (accountId: string) => Promise<T>;
  fetchImpl?: typeof fetch;
}): Promise<FanOutResult<T>[]> {
  const origin =
    options.origin !== undefined ? options.origin : cronOrigin();
  if (origin) {
    const fetchImpl = options.fetchImpl ?? fetch;
    return Promise.all(
      options.accounts.map((account) =>
        invokeRemote<T>(fetchImpl, origin, account, options),
      ),
    );
  }
  return Promise.all(
    options.accounts.map(async (account) => {
      try {
        const result = await options.runLocal(account.id);
        return { email: account.email, ok: true, result };
      } catch (error) {
        return {
          email: account.email,
          ok: false,
          error:
            error instanceof Error ? error.message.slice(0, 160) : "run failed",
        };
      }
    }),
  );
}

async function invokeRemote<T>(
  fetchImpl: typeof fetch,
  origin: string,
  account: AccountRef,
  options: {
    path: string;
    searchParams?: Record<string, string>;
    authorization: string | null;
  },
): Promise<FanOutResult<T>> {
  try {
    const response = await fetchImpl(
      accountWorkerUrl(origin, options.path, account.id, options.searchParams),
      {
        headers: {
          accept: "application/json",
          ...(options.authorization
            ? { authorization: options.authorization }
            : {}),
        },
      },
    );
    const body = (await response.json()) as {
      error?: string;
      report?: T;
    };
    if (!response.ok) {
      return {
        email: account.email,
        ok: false,
        error: body.error ?? `worker ${response.status}`,
      };
    }
    return { email: account.email, ok: true, result: body.report as T };
  } catch (error) {
    return {
      email: account.email,
      ok: false,
      error:
        error instanceof Error ? error.message.slice(0, 160) : "fan-out failed",
    };
  }
}
