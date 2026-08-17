/**
 * One-time migration: seal the secrets already sitting in the legacy KV store.
 *
 * The code now seals on write, but documents written before that change still
 * hold plaintext until something rewrites them. This reads each one, seals the
 * secret fields, and writes it back — then reports what remains readable so the
 * result can be verified rather than assumed.
 *
 * Prints no secret values.
 */
import kv from "../src/lib/store/kv.ts";
import { seal } from "../src/lib/store/secret-at-rest.ts";

const { kvGet, kvSet, accountKey } = kv as unknown as {
  kvGet: <T>(key: string) => Promise<T | null>;
  kvSet: (key: string, value: unknown) => Promise<void>;
  accountKey: (email: string) => string;
};

const email = process.argv[2] ?? "conall@rditrials.com";
const report: Record<string, unknown> = {};

// --- Mail accounts -------------------------------------------------------
type Account = {
  id: string;
  accessToken?: unknown;
  refreshToken?: unknown;
  [k: string]: unknown;
};
const store = await kvGet<{ accounts: Account[] }>("accounts");
if (store?.accounts?.length) {
  let sealed = 0;
  const accounts = store.accounts.map((account) => {
    const next = { ...account };
    for (const field of ["accessToken", "refreshToken"] as const) {
      const value = account[field];
      if (typeof value === "string" && value) {
        next[field] = seal(value, account.id);
        sealed++;
      }
    }
    return next;
  });
  await kvSet("accounts", { accounts });
  report.accountsResealed = sealed;
  report.accountCount = accounts.length;
}

// --- Salesforce ----------------------------------------------------------
const scope = `salesforce:${accountKey(email)}`;

type App = { clientSecret?: unknown; [k: string]: unknown };
const app = await kvGet<App>(`salesforce-app:${accountKey(email)}`);
if (app && typeof app.clientSecret === "string" && app.clientSecret) {
  await kvSet(`salesforce-app:${accountKey(email)}`, {
    ...app,
    clientSecret: seal(app.clientSecret, scope),
  });
  report.salesforceAppResealed = true;
}

type Conn = { refreshToken?: unknown; [k: string]: unknown };
const conn = await kvGet<Conn>(`salesforce-conn:${accountKey(email)}`);
if (conn && typeof conn.refreshToken === "string" && conn.refreshToken) {
  await kvSet(`salesforce-conn:${accountKey(email)}`, {
    ...conn,
    refreshToken: seal(conn.refreshToken, scope),
  });
  report.salesforceConnResealed = true;
}

console.log(JSON.stringify(report, null, 2));
