import { createSign } from "node:crypto";

/**
 * SALESFORCE — the live business database behind the mail. Opportunities
 * (with amounts and stages), active studies, sites and investigators.
 *
 * Auth always ends in a refresh or assertion the server can replay, so
 * the background sync works with nobody signed in. Credentials are
 * resolved in lib/store/salesforce-auth; this module only spends them:
 *
 *  1. Refresh token — what "Log in with Salesforce" produces, and what
 *     a user can revoke themselves.
 *  2. JWT bearer (a Connected App with a certificate) — for an
 *     unattended integration user, configured in the environment.
 *  3. Client credentials — only some orgs enable it.
 *
 * The schema is DISCOVERED, not assumed: every org names its custom
 * objects differently (Study__c, Clinical_Study__c, Protocol__c), so we
 * ask Salesforce what exists and match by shape.
 */

export type SalesforceCreds = {
  /** login.salesforce.com, or test.salesforce.com for a sandbox */
  loginUrl: string;
  clientId: string;
  clientSecret?: string;
  /** JWT bearer flow */
  username?: string;
  privateKey?: string;
  /** Refresh-token flow */
  refreshToken?: string;
};

export type SalesforceAuth = {
  accessToken: string;
  instanceUrl: string;
};

function base64url(input: Buffer | string): string {
  return Buffer.from(input)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

async function tokenRequest(
  loginUrl: string,
  body: Record<string, string>,
): Promise<SalesforceAuth> {
  const res = await fetch(`${loginUrl.replace(/\/$/, "")}/services/oauth2/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(body).toString(),
  });
  const json = (await res.json().catch(() => ({}))) as {
    access_token?: string;
    instance_url?: string;
    error?: string;
    error_description?: string;
  };
  if (!res.ok || !json.access_token || !json.instance_url) {
    throw new Error(
      `Salesforce auth ${res.status}: ${json.error_description ?? json.error ?? "no token"}`,
    );
  }
  return { accessToken: json.access_token, instanceUrl: json.instance_url };
}

export async function authenticate(
  creds: SalesforceCreds,
): Promise<SalesforceAuth> {
  if (creds.username && creds.privateKey) {
    // JWT bearer: sign an assertion the Connected App's cert can verify
    const header = base64url(JSON.stringify({ alg: "RS256" }));
    const claims = base64url(
      JSON.stringify({
        iss: creds.clientId,
        sub: creds.username,
        aud: creds.loginUrl.replace(/\/$/, ""),
        exp: Math.floor(Date.now() / 1000) + 180,
      }),
    );
    const signer = createSign("RSA-SHA256");
    signer.update(`${header}.${claims}`);
    const signature = base64url(signer.sign(creds.privateKey));
    return tokenRequest(creds.loginUrl, {
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: `${header}.${claims}.${signature}`,
    });
  }

  if (creds.refreshToken) {
    return tokenRequest(creds.loginUrl, {
      grant_type: "refresh_token",
      client_id: creds.clientId,
      ...(creds.clientSecret ? { client_secret: creds.clientSecret } : {}),
      refresh_token: creds.refreshToken,
    });
  }

  if (creds.clientSecret) {
    return tokenRequest(creds.loginUrl, {
      grant_type: "client_credentials",
      client_id: creds.clientId,
      client_secret: creds.clientSecret,
    });
  }

  throw new Error(
    "Salesforce needs either a private key + username (JWT bearer), a refresh token, or a client secret",
  );
}

const API = "v61.0";

export async function soql<T>(
  auth: SalesforceAuth,
  query: string,
): Promise<T[]> {
  const out: T[] = [];
  let url = `${auth.instanceUrl}/services/data/${API}/query?q=${encodeURIComponent(query)}`;
  for (let page = 0; page < 12; page++) {
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${auth.accessToken}` },
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`SOQL ${res.status}: ${text.slice(0, 200)}`);
    }
    const json = (await res.json()) as {
      records?: T[];
      nextRecordsUrl?: string;
    };
    out.push(...(json.records ?? []));
    if (!json.nextRecordsUrl) break;
    url = `${auth.instanceUrl}${json.nextRecordsUrl}`;
  }
  return out;
}

export type ObjectMeta = {
  name: string;
  label: string;
  fields: { name: string; label: string; type: string }[];
};

/** Every queryable object in the org, by API name. */
export async function listObjects(
  auth: SalesforceAuth,
): Promise<{ name: string; label: string; custom: boolean }[]> {
  const res = await fetch(
    `${auth.instanceUrl}/services/data/${API}/sobjects`,
    { headers: { Authorization: `Bearer ${auth.accessToken}` } },
  );
  if (!res.ok) throw new Error(`describe global ${res.status}`);
  const json = (await res.json()) as {
    sobjects?: {
      name: string;
      label: string;
      custom: boolean;
      queryable: boolean;
    }[];
  };
  return (json.sobjects ?? [])
    .filter((s) => s.queryable)
    .map((s) => ({ name: s.name, label: s.label, custom: s.custom }));
}

export async function describeObject(
  auth: SalesforceAuth,
  name: string,
): Promise<ObjectMeta | null> {
  const res = await fetch(
    `${auth.instanceUrl}/services/data/${API}/sobjects/${name}/describe`,
    { headers: { Authorization: `Bearer ${auth.accessToken}` } },
  );
  if (!res.ok) return null;
  const json = (await res.json()) as {
    name: string;
    label: string;
    fields?: { name: string; label: string; type: string }[];
  };
  return {
    name: json.name,
    label: json.label,
    fields: (json.fields ?? []).map((f) => ({
      name: f.name,
      label: f.label,
      type: f.type,
    })),
  };
}

/** First field whose API name or label matches any pattern. */
export function pickField(
  meta: ObjectMeta,
  patterns: RegExp[],
  types?: string[],
): string | undefined {
  for (const p of patterns) {
    const hit = meta.fields.find(
      (f) =>
        (p.test(f.name) || p.test(f.label)) &&
        (!types || types.includes(f.type)),
    );
    if (hit) return hit.name;
  }
  return undefined;
}
