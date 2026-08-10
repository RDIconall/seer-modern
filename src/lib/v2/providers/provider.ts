import { getCredentials, type MailAccount } from "../db/accounts";
import { freshAccessToken, type RefreshFn } from "./token-service";
import { GmailProvider } from "./gmail";
import { OutlookProvider } from "./outlook";
import type { MailProvider } from "./types";

/**
 * The provider factory. Everything above the adapter layer asks for a
 * `MailProvider` by account and never constructs Gmail or Outlook directly.
 * Access tokens are refreshed through the locked token service.
 */

const googleRefresh: RefreshFn = async (refreshToken) => {
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: process.env.AUTH_GOOGLE_ID ?? "",
      client_secret: process.env.AUTH_GOOGLE_SECRET ?? "",
      grant_type: "refresh_token",
      refresh_token: refreshToken,
    }),
  });
  if (!res.ok) throw new Error(`google token refresh failed: ${res.status}`);
  const json = (await res.json()) as {
    access_token: string;
    refresh_token?: string;
    expires_in: number;
  };
  return {
    accessToken: json.access_token,
    refreshToken: json.refresh_token,
    expiresAt: Date.now() + json.expires_in * 1000,
  };
};

const microsoftRefresh: RefreshFn = async (refreshToken) => {
  const tenant = process.env.AUTH_MICROSOFT_ENTRA_ID_TENANT ?? "common";
  const res = await fetch(
    `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`,
    {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: process.env.AUTH_MICROSOFT_ENTRA_ID_ID ?? "",
        client_secret: process.env.AUTH_MICROSOFT_ENTRA_ID_SECRET ?? "",
        grant_type: "refresh_token",
        refresh_token: refreshToken,
      }),
    },
  );
  if (!res.ok) throw new Error(`microsoft token refresh failed: ${res.status}`);
  const json = (await res.json()) as {
    access_token: string;
    refresh_token?: string;
    expires_in: number;
  };
  return {
    accessToken: json.access_token,
    refreshToken: json.refresh_token,
    expiresAt: Date.now() + json.expires_in * 1000,
  };
};

export async function providerFor(account: MailAccount): Promise<MailProvider> {
  const cred = await getCredentials(account.id);
  if (!cred) throw new Error(`no credentials for account ${account.id}`);
  const refreshFn = account.provider === "google" ? googleRefresh : microsoftRefresh;
  const accessToken = await freshAccessToken(account.id, account.provider, refreshFn);
  return account.provider === "google"
    ? new GmailProvider({ accessToken, accountEmail: account.email })
    : new OutlookProvider({ accessToken, accountEmail: account.email });
}
