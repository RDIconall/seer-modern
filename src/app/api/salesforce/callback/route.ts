import { requireMailSession } from "@/lib/mail/session";
import { loadApp, saveConnection } from "@/lib/store/salesforce-auth";
import { cookies } from "next/headers";
import { NextResponse } from "next/server";

/**
 * Salesforce sends the user back here with a one-time code. We trade it
 * for a refresh token using the verifier we kept, then store the
 * connection against the mail account and send them back to Settings.
 */
export async function GET(req: Request) {
  const origin = new URL(req.url).origin;
  const jarEarly = await cookies();
  const returnTo = jarEarly.get("sf_return")?.value ?? "/";
  const settings = (note: string) =>
    NextResponse.redirect(
      new URL(`${returnTo}?settings=1&sf=${note}`, origin),
    );

  const session = await requireMailSession();
  if (!session) return settings("signin");

  const url = new URL(req.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const denied = url.searchParams.get("error");
  if (denied) return settings(encodeURIComponent(denied));
  if (!code) return settings("no-code");

  const verifier = jarEarly.get("sf_verifier")?.value;
  const expected = jarEarly.get("sf_state")?.value;
  if (!verifier || !expected || expected !== state) return settings("state");

  const app = await loadApp(session.email);
  if (!app) return settings("no-app");

  const body: Record<string, string> = {
    grant_type: "authorization_code",
    code,
    client_id: app.clientId,
    redirect_uri: `${origin}/api/salesforce/callback`,
    code_verifier: verifier,
  };
  if (app.clientSecret) body.client_secret = app.clientSecret;

  const res = await fetch(
    `${app.loginUrl.replace(/\/$/, "")}/services/oauth2/token`,
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(body).toString(),
    },
  );
  const json = (await res.json().catch(() => ({}))) as {
    access_token?: string;
    refresh_token?: string;
    instance_url?: string;
    id?: string;
    error?: string;
    error_description?: string;
  };
  if (!res.ok || !json.refresh_token || !json.instance_url) {
    const reason = String(
      json.error_description ?? json.error ?? `HTTP ${res.status}`,
    ).slice(0, 160);
    console.error("[seer] salesforce token exchange failed:", reason);
    // No refresh token usually means the Connected App is missing the
    // refresh_token scope — say which, rather than "failed".
    // Otherwise pass Salesforce's OWN words through: "redirect_uri_mismatch"
    // is a five-second fix, "Salesforce rejected the login" is a guess.
    return settings(
      res.ok && !json.refresh_token
        ? "no-refresh-scope"
        : `token:${encodeURIComponent(reason)}`,
    );
  }

  // The identity URL names the person and org behind the connection
  let username: string | undefined;
  let displayName: string | undefined;
  let orgId: string | undefined;
  if (json.id && json.access_token) {
    const who = (await fetch(json.id, {
      headers: { Authorization: `Bearer ${json.access_token}` },
    })
      .then((r) => (r.ok ? r.json() : null))
      .catch(() => null)) as {
      username?: string;
      display_name?: string;
      organization_id?: string;
    } | null;
    username = who?.username;
    displayName = who?.display_name;
    orgId = who?.organization_id;
  }

  await saveConnection(session.email, {
    refreshToken: json.refresh_token,
    instanceUrl: json.instance_url,
    loginUrl: app.loginUrl,
    ...(username ? { username } : {}),
    ...(displayName ? { displayName } : {}),
    ...(orgId ? { orgId } : {}),
    connectedAt: new Date().toISOString(),
  });

  const out = settings("connected");
  out.cookies.delete("sf_verifier");
  out.cookies.delete("sf_state");
  out.cookies.delete("sf_return");
  return out;
}
