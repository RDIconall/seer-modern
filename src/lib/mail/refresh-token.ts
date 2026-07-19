import type { JWT } from "next-auth/jwt";

type RefreshableToken = JWT & {
  accessToken?: string;
  refreshToken?: string;
  expiresAt?: number;
  provider?: string;
  error?: string;
};

export async function refreshAccessToken(
  token: RefreshableToken,
): Promise<RefreshableToken> {
  if (!token.refreshToken || !token.provider) {
    return { ...token, error: "RefreshTokenMissing" };
  }

  try {
    if (token.provider === "google") {
      return await refreshGoogle(token);
    }
    if (token.provider === "microsoft-entra-id") {
      return await refreshMicrosoft(token);
    }
    return { ...token, error: "UnsupportedProvider" };
  } catch {
    return { ...token, error: "RefreshAccessTokenError" };
  }
}

async function refreshGoogle(
  token: RefreshableToken,
): Promise<RefreshableToken> {
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: process.env.AUTH_GOOGLE_ID ?? "",
      client_secret: process.env.AUTH_GOOGLE_SECRET ?? "",
      grant_type: "refresh_token",
      refresh_token: token.refreshToken!,
    }),
  });
  const data = (await res.json()) as {
    access_token?: string;
    expires_in?: number;
    refresh_token?: string;
    error?: string;
  };
  if (!res.ok || !data.access_token) {
    throw new Error(data.error ?? "Google refresh failed");
  }
  return {
    ...token,
    accessToken: data.access_token,
    expiresAt: Math.floor(Date.now() / 1000) + (data.expires_in ?? 3600),
    refreshToken: data.refresh_token ?? token.refreshToken,
    error: undefined,
  };
}

async function refreshMicrosoft(
  token: RefreshableToken,
): Promise<RefreshableToken> {
  const tenant = process.env.AUTH_MICROSOFT_ENTRA_ID_ISSUER
    ? new URL(process.env.AUTH_MICROSOFT_ENTRA_ID_ISSUER).pathname.split("/")[1]
    : "common";
  const res = await fetch(
    `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`,
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: process.env.AUTH_MICROSOFT_ENTRA_ID_ID ?? "",
        client_secret: process.env.AUTH_MICROSOFT_ENTRA_ID_SECRET ?? "",
        grant_type: "refresh_token",
        refresh_token: token.refreshToken!,
        scope:
          "openid profile email offline_access User.Read Mail.ReadWrite",
      }),
    },
  );
  const data = (await res.json()) as {
    access_token?: string;
    expires_in?: number;
    refresh_token?: string;
    error?: string;
  };
  if (!res.ok || !data.access_token) {
    throw new Error(data.error ?? "Microsoft refresh failed");
  }
  return {
    ...token,
    accessToken: data.access_token,
    expiresAt: Math.floor(Date.now() / 1000) + (data.expires_in ?? 3600),
    refreshToken: data.refresh_token ?? token.refreshToken,
    error: undefined,
  };
}

/** True when the access token should be refreshed soon (60s skew). */
export function accessTokenNeedsRefresh(token: RefreshableToken): boolean {
  if (!token.expiresAt) return false;
  return Date.now() >= token.expiresAt * 1000 - 60_000;
}
