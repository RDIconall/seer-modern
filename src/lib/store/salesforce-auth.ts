import type { SalesforceCreds } from "@/lib/crm/salesforce-api";
import { accountKey, kvDelete, kvGet, kvSet } from "@/lib/store/kv";
import { open, seal, type StoredSecret } from "@/lib/store/secret-at-rest";

/**
 * "LOG IN WITH SALESFORCE" — the connection, owned by the user.
 *
 * The server-to-server flows (JWT bearer, client credentials) need a
 * certificate or a secret sitting in the environment, which means a
 * deploy to change and an admin to set up. The web server flow with
 * PKCE needs neither: the Connected App's consumer key is public by
 * design, the proof is a one-time code verifier, and what comes back is
 * a refresh token bound to the person who clicked Allow.
 *
 * That refresh token is what makes the background sync possible with
 * nobody signed in — the same unattended access, without the secrets.
 */

export type SalesforceApp = {
  /** Connected App consumer key. Public under PKCE — not a secret. */
  clientId: string;
  /** Only when the org keeps "Require Secret for Web Server Flow" on */
  clientSecret?: string;
  /** login.salesforce.com, or test.salesforce.com for a sandbox */
  loginUrl: string;
  /** Where it came from, so the UI can explain itself */
  source: "settings" | "env";
};

export type SalesforceConnection = {
  refreshToken: string;
  /** The org's own API host, returned with the token */
  instanceUrl: string;
  loginUrl: string;
  username?: string;
  displayName?: string;
  orgId?: string;
  connectedAt: string;
};

const appKey = (email: string) => `salesforce-app:${accountKey(email)}`;
const connKey = (email: string) => `salesforce-conn:${accountKey(email)}`;

/** What binds the ciphertext to its owner, so it cannot be replayed. */
const scope = (email: string) => `salesforce:${accountKey(email)}`;

/** The consumer key is public under PKCE; the secret and refresh token are not. */
type PersistedApp = Omit<SalesforceApp, "source" | "clientSecret"> & {
  clientSecret?: StoredSecret;
};
type PersistedConnection = Omit<SalesforceConnection, "refreshToken"> & {
  refreshToken?: StoredSecret;
};

export const DEFAULT_LOGIN_URL = "https://login.salesforce.com";

/** The Connected App to authorize against: the user's, else the deploy's. */
export async function loadApp(
  accountEmail: string,
): Promise<SalesforceApp | null> {
  const stored = await kvGet<PersistedApp>(appKey(accountEmail));
  if (stored?.clientId) {
    return {
      ...stored,
      clientSecret: open(stored.clientSecret, scope(accountEmail)),
      source: "settings",
    };
  }

  const clientId =
    process.env.SALESFORCE_CLIENT_ID ?? process.env.SF_CLIENT_ID;
  if (!clientId) return null;
  return {
    clientId,
    clientSecret:
      process.env.SALESFORCE_CLIENT_SECRET ?? process.env.SF_CLIENT_SECRET,
    loginUrl:
      process.env.SALESFORCE_LOGIN_URL ??
      process.env.SF_LOGIN_URL ??
      DEFAULT_LOGIN_URL,
    source: "env",
  };
}

export async function saveApp(
  accountEmail: string,
  app: Omit<SalesforceApp, "source">,
): Promise<void> {
  const persisted: PersistedApp = {
    ...app,
    clientSecret: seal(app.clientSecret, scope(accountEmail)),
  };
  await kvSet(appKey(accountEmail), persisted);
}

export async function loadConnection(
  accountEmail: string,
): Promise<SalesforceConnection | null> {
  const stored = await kvGet<PersistedConnection>(connKey(accountEmail));
  if (!stored) return null;
  const refreshToken = open(stored.refreshToken, scope(accountEmail));
  // Without a refresh token the connection cannot sync; treat it as absent so
  // the caller falls back to the environment flows rather than half-working.
  if (!refreshToken) return null;
  return { ...stored, refreshToken };
}

export async function saveConnection(
  accountEmail: string,
  conn: SalesforceConnection,
): Promise<void> {
  const persisted: PersistedConnection = {
    ...conn,
    refreshToken: seal(conn.refreshToken, scope(accountEmail)),
  };
  await kvSet(connKey(accountEmail), persisted);
}

/** Re-seal stored CRM secrets; the read/write round trip is the migration. */
export async function resealSalesforce(accountEmail: string): Promise<{
  app: boolean;
  connection: boolean;
}> {
  const app = await loadApp(accountEmail);
  const connection = await loadConnection(accountEmail);
  if (app && app.source === "settings") {
    await saveApp(accountEmail, {
      clientId: app.clientId,
      clientSecret: app.clientSecret,
      loginUrl: app.loginUrl,
    });
  }
  if (connection) await saveConnection(accountEmail, connection);
  return { app: Boolean(app && app.source === "settings"), connection: Boolean(connection) };
}

export async function clearConnection(accountEmail: string): Promise<void> {
  await kvDelete(connKey(accountEmail));
}

/**
 * Credentials for a sync. A user's own connection wins over anything in
 * the environment: they authorized it, they can revoke it, and it
 * carries their permissions rather than an integration user's.
 */
export async function resolveCreds(accountEmail: string): Promise<{
  creds: SalesforceCreds;
  via: "login" | "jwt-bearer" | "refresh-token" | "client-credentials";
} | null> {
  const conn = await loadConnection(accountEmail);
  const app = await loadApp(accountEmail);
  if (conn && app) {
    return {
      creds: {
        loginUrl: conn.loginUrl,
        clientId: app.clientId,
        clientSecret: app.clientSecret,
        refreshToken: conn.refreshToken,
      },
      via: "login",
    };
  }

  // No connection: fall back to the unattended env flows
  const clientId =
    process.env.SALESFORCE_CLIENT_ID ?? process.env.SF_CLIENT_ID;
  if (!clientId) return null;
  const creds: SalesforceCreds = {
    loginUrl:
      process.env.SALESFORCE_LOGIN_URL ??
      process.env.SF_LOGIN_URL ??
      DEFAULT_LOGIN_URL,
    clientId,
    clientSecret:
      process.env.SALESFORCE_CLIENT_SECRET ?? process.env.SF_CLIENT_SECRET,
    username: process.env.SALESFORCE_USERNAME ?? process.env.SF_USERNAME,
    privateKey: (
      process.env.SALESFORCE_PRIVATE_KEY ?? process.env.SF_PRIVATE_KEY
    )?.replace(/\\n/g, "\n"),
    refreshToken:
      process.env.SALESFORCE_REFRESH_TOKEN ?? process.env.SF_REFRESH_TOKEN,
  };
  if (creds.privateKey && creds.username) return { creds, via: "jwt-bearer" };
  if (creds.refreshToken) return { creds, via: "refresh-token" };
  if (creds.clientSecret) return { creds, via: "client-credentials" };
  return null;
}
