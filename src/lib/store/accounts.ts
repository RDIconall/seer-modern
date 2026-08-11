import { cookies } from "next/headers";
import { kvGet, kvSet } from "@/lib/store/kv";
import { open, seal, type StoredSecret } from "@/lib/store/secret-at-rest";

const ACCOUNTS_KEY = "accounts";
export const ACTIVE_ACCOUNT_COOKIE = "seer_active_account";
export const LEGACY_ACCOUNT_FALLBACK_ENV =
  "SEER_V3_LEGACY_ACCOUNT_FALLBACK";

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

/**
 * On disk the tokens are sealed. Callers still see plaintext: the boundary
 * below opens on read and seals on write, so a database dump yields no usable
 * mailbox credential.
 */
type PersistedAccount = Omit<StoredAccount, "accessToken" | "refreshToken"> & {
  accessToken?: StoredSecret;
  refreshToken?: StoredSecret;
};

type PersistedShape = { accounts: PersistedAccount[] };

/** Temporary migration escape hatch. It is deliberately disabled by default. */
export function legacyAccountFallbackEnabled(): boolean {
  return process.env[LEGACY_ACCOUNT_FALLBACK_ENV] === "1";
}

function requireLegacyAccountStore(): void {
  if (!legacyAccountFallbackEnabled()) {
    throw new Error("legacy account store is disabled after v3 cutover");
  }
}

async function readStore(): Promise<StoreShape> {
  const parsed = await kvGet<PersistedShape>(ACCOUNTS_KEY);
  const accounts = (parsed?.accounts ?? []).map((account) => ({
    ...account,
    accessToken: open(account.accessToken, account.id),
    refreshToken: open(account.refreshToken, account.id),
  }));
  return { accounts };
}

async function writeStore(store: StoreShape) {
  const accounts: PersistedAccount[] = store.accounts.map((account) => ({
    ...account,
    accessToken: seal(account.accessToken, account.id),
    refreshToken: seal(account.refreshToken, account.id),
  }));
  await kvSet(ACCOUNTS_KEY, { accounts });
}

/**
 * Re-seal everything already on disk. Reading opens legacy plaintext and
 * writing seals it, so the round trip is the migration.
 */
export async function resealAccounts(): Promise<number> {
  requireLegacyAccountStore();
  const store = await readStore();
  await writeStore(store);
  return store.accounts.length;
}

export async function listAccounts(): Promise<
  Omit<StoredAccount, "accessToken" | "refreshToken">[]
> {
  requireLegacyAccountStore();
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

export async function listAccountsForOwner(
  ownerEmail: string,
): Promise<Omit<StoredAccount, "accessToken" | "refreshToken">[]> {
  requireLegacyAccountStore();
  const email = ownerEmail.toLowerCase().trim();
  const store = await readStore();
  return store.accounts
    .filter((account) => account.email.toLowerCase() === email)
    .map((account) => ({
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
  requireLegacyAccountStore();
  const store = await readStore();
  return store.accounts.find((a) => a.id === id);
}

/** Full accounts WITH tokens — background services only (cron sync). */
export async function listAccountsWithTokens(): Promise<StoredAccount[]> {
  requireLegacyAccountStore();
  const store = await readStore();
  return store.accounts;
}

/**
 * Pure owner boundary used by both the request resolver and migration tests.
 * A valid active id may select a different mailbox for the same signed-in
 * owner; an invalid/foreign id falls back to that owner's session mailbox.
 */
export function selectOwnedAccount(
  accounts: StoredAccount[],
  ownerEmail: string,
  activeId: string | null,
  provider?: MailProvider,
): StoredAccount | null {
  const owner = ownerEmail.toLowerCase().trim();
  if (activeId) {
    const active = accounts.find(
      (account) =>
        account.id === activeId &&
        account.email.toLowerCase() === owner &&
        Boolean(account.accessToken),
    );
    if (active) return active;
  }
  return (
    accounts.find(
      (account) =>
        account.email.toLowerCase() === owner &&
        (!provider || account.provider === provider) &&
        Boolean(account.accessToken),
    ) ?? null
  );
}

export async function upsertAccount(input: {
  provider: MailProvider;
  email: string;
  name?: string;
  accessToken?: string;
  refreshToken?: string;
  expiresAt?: number;
}): Promise<StoredAccount> {
  void input;
  throw new Error("legacy account store is read-only after v3 cutover");
}

/** Drop dead tokens (after revocation) while keeping the account entry. */
export async function clearAccountTokens(id: string) {
  void id;
  throw new Error("legacy account store is read-only after v3 cutover");
}

export async function removeAccount(id: string) {
  void id;
  throw new Error("legacy account store is read-only after v3 cutover");
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
  ownerEmail: string,
  provider?: MailProvider,
): Promise<StoredAccount | null> {
  if (!legacyAccountFallbackEnabled()) return null;
  const listed = await readStore();
  return selectOwnedAccount(
    listed.accounts,
    ownerEmail,
    await getActiveAccountId(),
    provider,
  );
}

export function providerLabel(provider: MailProvider) {
  return provider === "google" ? "Gmail" : "Outlook";
}
