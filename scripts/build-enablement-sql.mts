/**
 * Build the one-time v2 enablement SQL for an account, WITHOUT needing a direct
 * Postgres connection (the production connection string is a Sensitive secret).
 *
 * Reads the legacy account + relationship signals from the existing KV store,
 * encrypts OAuth tokens locally with the SAME SEER_CREDENTIAL_KEY the app uses,
 * and emits SQL that can be applied through an authenticated admin channel.
 *
 * Plaintext tokens never appear in the output — only AES-256-GCM ciphertext.
 */
import { promises as fs } from "node:fs";
import kv from "../src/lib/store/kv.ts";
import { encryptCredential } from "../src/lib/v2/crypto/credentials.ts";
import {
  collectPeople,
  type PersonSeed,
} from "../src/lib/v2/db/seed-relationships.ts";
import type { StoredAccount } from "../src/lib/store/accounts.ts";
import type { MatterEdits } from "../src/lib/store/manual-matters.ts";

const { kvGet } = kv as unknown as {
  kvGet: <T>(key: string) => Promise<T | null>;
};

function arg(flag: string, fallback = ""): string {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

/** Single-quote escaping for literals we build ourselves. */
function sql(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/**
 * The legacy store keeps OAuth expiry in SECONDS (the NextAuth convention),
 * while v2 works in milliseconds. A value below ~2001-in-ms is really seconds,
 * so normalize instead of writing a 1970 timestamp that would make every token
 * look permanently expired.
 */
function epochMs(value: number | undefined): number | undefined {
  if (!value) return undefined;
  return value < 1e12 ? value * 1000 : value;
}

async function main() {
  const email = arg("--account").toLowerCase();
  const accountUuid = arg("--account-id");
  const userUuid = arg("--user-id");
  const outputPath = arg("--out", "/tmp/v2-enablement.sql");
  if (!email || !accountUuid || !userUuid) {
    throw new Error("--account, --account-id and --user-id are required");
  }

  const store = await kvGet<{ accounts: StoredAccount[] }>("accounts");
  const account = (store?.accounts ?? []).find(
    (candidate) => candidate.email.toLowerCase() === email,
  );
  if (!account) throw new Error(`no legacy account for ${email}`);
  const provider = account.provider === "google" ? "google" : "microsoft";

  // Encrypt with the account UUID as additional authenticated data, exactly as
  // the app does when it later decrypts.
  const ciphertext: Record<string, unknown> = {};
  if (account.accessToken) {
    ciphertext.accessToken = encryptCredential(account.accessToken, accountUuid);
  }
  if (account.refreshToken) {
    ciphertext.refreshToken = encryptCredential(
      account.refreshToken,
      accountUuid,
    );
  }

  const key = email;
  const [people, history, personal, edits] = await Promise.all([
    kvGet<Record<string, { tier?: string; vip?: boolean; name?: string }>>(
      `people:${key}`,
    ),
    kvGet<{
      history?: { contacts?: Record<string, { sentTo?: number }> };
      contacts?: Record<string, { sentTo?: number }>;
    }>(`mail-history:${key}`),
    kvGet<{ contacts?: string[] }>(`personal:${key}`),
    kvGet<MatterEdits>(`matter-edits:${key}`),
  ]);

  const seeds: PersonSeed[] = collectPeople({
    people: people ?? null,
    history: history?.history ?? history ?? null,
    contacts: personal?.contacts ?? null,
  });

  const lines: string[] = [];
  lines.push("begin;");
  lines.push(
    `insert into seer.users (id, email) values (${sql(userUuid)}::uuid, ${sql(email)}) on conflict (email) do nothing;`,
  );
  lines.push(
    `insert into seer.mail_accounts (id, user_id, provider, email, display_name)
       values (${sql(accountUuid)}::uuid, ${sql(userUuid)}::uuid, ${sql(provider)}, ${sql(email)}, ${sql(account.name ?? email)})
       on conflict (provider, email) do nothing;`,
  );
  lines.push(
    `insert into seer.oauth_credentials (account_id, provider, ciphertext, expires_at, version)
       values (${sql(accountUuid)}::uuid, ${sql(provider)}, ${sql(JSON.stringify(ciphertext))}::jsonb,
               ${(() => {
                 const ms = epochMs(account.expiresAt);
                 return ms ? `to_timestamp(${Math.floor(ms / 1000)})` : "null";
               })()}, 1)
       on conflict (account_id) do update
         set ciphertext = excluded.ciphertext,
             expires_at = excluded.expires_at,
             version = seer.oauth_credentials.version + 1,
             rotated_at = now();`,
  );

  // Relationship graph — seeded BEFORE any read so the safety floor has data.
  const peopleValues = seeds.map(
    (person) =>
      `(${sql(accountUuid)}::uuid, ${sql(person.email)}, ${person.name ? sql(person.name) : "null"}, ${sql(person.tier)}, ${person.vip ? "true" : "false"}, ${person.vip ? "'user'" : "'inferred'"})`,
  );
  for (let index = 0; index < peopleValues.length; index += 200) {
    const batch = peopleValues.slice(index, index + 200);
    lines.push(
      `insert into seer.people (account_id, email, display_name, tier, vip, vip_source) values
${batch.join(",\n")}
on conflict (account_id, email) do update
  set tier = excluded.tier,
      vip = seer.people.vip or excluded.vip,
      display_name = coalesce(excluded.display_name, seer.people.display_name);`,
    );
  }

  // Hand-authored matter names are explicit user intent and are preserved.
  const manual = edits?.manual ?? [];
  for (const matter of manual) {
    lines.push(
      `insert into seer.matters (account_id, title, org_unit, title_source)
         values (${sql(accountUuid)}::uuid, ${sql(matter.title)}, ${matter.orgUnit ? sql(matter.orgUnit) : "null"}, 'user');`,
    );
  }

  lines.push("commit;");
  await fs.writeFile(outputPath, lines.join("\n\n"), "utf8");

  console.log(
    JSON.stringify(
      {
        account: email,
        provider,
        hasRefreshToken: Boolean(account.refreshToken),
        peopleSeeded: seeds.length,
        vips: seeds.filter((person) => person.vip).length,
        manualMatters: manual.length,
        outputPath,
      },
      null,
      2,
    ),
  );
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
