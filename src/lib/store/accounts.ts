import { cookies } from "next/headers";
import { kvGet, kvSet } from "@/lib/store/kv";

const ACCOUNTS_KEY = "accounts";
export const ACTIVE_ACCOUNT_COOKIE = "seer_active_account";

export type MailProvider = "google" | "microsoft-entra-id";

export type StoredAccount = {
  id: string;
  provider: MailProvider;
  email: string;
  name: string;
  accessToken?: string;
  refreshToken?: string;
  expiresAt?: number;
  updatedAt: string;
};

type StoreShape = {
  accounts: StoredAccount[];
};

function accountId(provider: MailProvider, email: string) {
  return `${provider}:${email.toLowerCase()}`;
}

async function readStore(): Promise<StoreShape> {
  const parsed = await kvGet<StoreShape>(ACCOUNTS_KEY);
  return { accounts: parsed?.accounts ?? [] };
}

async function writeStore(store: StoreShape) {
  await kvSet(ACCOUNTS_KEY, store);
}

export async function listAccounts(): Promise<
  Omit<StoredAccount, "accessToken" | "refreshToken">[]
> {
  const store = await readStore();
  return store.accounts.map((account) => ({
    id: account.id,
    provider: account.provider,
    email: account.email,
    name: account.name,
    expiresAt: account.expiresAt,
    updatedAt: account.updatedAt,
  }));
}

export async function getAccount(
  id: string,
): Promise<StoredAccount | undefined> {
  const store = await readStore();
  return store.accounts.find((a) => a.id === id);
}

export async function upsertAccount(input: {
  provider: MailProvider;
  email: string;
  name?: string;
  accessToken?: string;
  refreshToken?: string;
  expiresAt?: number;
}): Promise<StoredAccount> {
  const email = input.email.toLowerCase();
  const id = accountId(input.provider, email);
  const store = await readStore();
  const existing = store.accounts.find((a) => a.id === id);
  const next: StoredAccount = {
    id,
    provider: input.provider,
    email,
    name: input.name ?? existing?.name ?? email,
    accessToken: input.accessToken ?? existing?.accessToken,
    refreshToken: input.refreshToken ?? existing?.refreshToken,
    expiresAt: input.expiresAt ?? existing?.expiresAt,
    updatedAt: new Date().toISOString(),
  };
  store.accounts = [
    next,
    ...store.accounts.filter((a) => a.id !== id),
  ].sort((a, b) => a.email.localeCompare(b.email));
  await writeStore(store);
  return next;
}

/** Drop dead tokens (after revocation) while keeping the account entry. */
export async function clearAccountTokens(id: string) {
  const store = await readStore();
  const account = store.accounts.find((a) => a.id === id);
  if (!account) return;
  account.accessToken = undefined;
  account.refreshToken = undefined;
  account.expiresAt = undefined;
  account.updatedAt = new Date().toISOString();
  await writeStore(store);
}

export async function removeAccount(id: string) {
  const store = await readStore();
  store.accounts = store.accounts.filter((a) => a.id !== id);
  await writeStore(store);
  const jar = await cookies();
  if (jar.get(ACTIVE_ACCOUNT_COOKIE)?.value === id) {
    jar.delete(ACTIVE_ACCOUNT_COOKIE);
  }
}

export async function setActiveAccountId(id: string | null) {
  const jar = await cookies();
  if (!id) {
    jar.delete(ACTIVE_ACCOUNT_COOKIE);
    return;
  }
  jar.set(ACTIVE_ACCOUNT_COOKIE, id, {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    maxAge: 60 * 60 * 24 * 365,
  });
}

export async function getActiveAccountId(): Promise<string | null> {
  const jar = await cookies();
  return jar.get(ACTIVE_ACCOUNT_COOKIE)?.value ?? null;
}

export async function resolveActiveAccount(
  fallback?: {
    provider?: string;
    email?: string | null;
    accessToken?: string;
    refreshToken?: string;
    expiresAt?: number;
    name?: string | null;
  },
): Promise<StoredAccount | null> {
  const activeId = await getActiveAccountId();
  if (activeId) {
    const fromStore = await getAccount(activeId);
    if (fromStore?.accessToken) return fromStore;
  }

  if (fallback?.provider && fallback.email && fallback.accessToken) {
    const provider = fallback.provider as MailProvider;
    if (provider !== "google" && provider !== "microsoft-entra-id") {
      return null;
    }
    return upsertAccount({
      provider,
      email: fallback.email,
      name: fallback.name ?? undefined,
      accessToken: fallback.accessToken,
      refreshToken: fallback.refreshToken,
      expiresAt: fallback.expiresAt,
    });
  }

  const listed = await readStore();
  return listed.accounts.find((a) => a.accessToken) ?? null;
}

export function providerLabel(provider: MailProvider) {
  return provider === "google" ? "Gmail" : "Outlook";
}
