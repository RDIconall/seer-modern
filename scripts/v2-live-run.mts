/**
 * Live end-to-end v2 run against the REAL mailbox — read-only.
 *
 * Ingests a bounded slice of the inbox, runs one chief-of-staff read per
 * conversation with real business context, applies the veto-only safety layer,
 * and prints the resulting inbox view. It never issues a provider mutation:
 * nothing is archived, deleted, or sent.
 *
 * Requires: KV (legacy accounts), AUTH_* client secrets, GOOGLE_GENERATIVE_AI_API_KEY.
 * Usage: vercel env run -e production -- tsx scripts/v2-live-run.mts --account <email> --convos 40
 */
import { startTestDb } from "./v2-testdb.mts";
import kv from "../src/lib/store/kv.ts";
import {
  upsertUser,
  upsertAccount,
  saveCredentials,
} from "../src/lib/v2/db/accounts.ts";
import { OutlookProvider } from "../src/lib/v2/providers/outlook.ts";
import { GmailProvider } from "../src/lib/v2/providers/gmail.ts";
import { freshAccessToken } from "../src/lib/v2/providers/token-service.ts";
import { writeConversationPage, saveCursor } from "../src/lib/v2/sync/repository.ts";
import { readBatch } from "../src/lib/v2/intelligence/read-batch.ts";
import { collectPeople, seedPeople } from "../src/lib/v2/db/seed-relationships.ts";
import { defaultReaderModel } from "../src/lib/v2/intelligence/model.ts";
import { buildInboxView } from "../src/lib/v2/view/build.ts";
import type { MailProvider } from "../src/lib/v2/providers/types.ts";
import type { StoredAccount } from "../src/lib/store/accounts.ts";

const { kvGet } = kv as unknown as { kvGet: <T>(k: string) => Promise<T | null> };

function arg(flag: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : fallback;
}

const targetEmail = (arg("--account") ?? "").toLowerCase();
const convoCap = Number(arg("--convos", "40"));

function microsoftTenant(): string {
  const issuer = process.env.AUTH_MICROSOFT_ENTRA_ID_ISSUER;
  if (issuer) {
    try {
      const segment = new URL(issuer).pathname.split("/")[1];
      if (segment) return segment;
    } catch {
      // fall through
    }
  }
  return process.env.AUTH_MICROSOFT_ENTRA_ID_TENANT || "common";
}

async function refreshFor(provider: "google" | "microsoft") {
  return async (refreshToken: string) => {
    const url =
      provider === "google"
        ? "https://oauth2.googleapis.com/token"
        : `https://login.microsoftonline.com/${microsoftTenant()}/oauth2/v2.0/token`;
    const body = new URLSearchParams({
      client_id:
        provider === "google"
          ? (process.env.AUTH_GOOGLE_ID ?? "")
          : (process.env.AUTH_MICROSOFT_ENTRA_ID_ID ?? ""),
      client_secret:
        provider === "google"
          ? (process.env.AUTH_GOOGLE_SECRET ?? "")
          : (process.env.AUTH_MICROSOFT_ENTRA_ID_SECRET ?? ""),
      grant_type: "refresh_token",
      refresh_token: refreshToken,
    });
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body,
    });
    if (!res.ok) {
      throw new Error(`${provider} refresh failed: ${res.status} ${(await res.text()).slice(0, 120)}`);
    }
    const j = (await res.json()) as {
      access_token: string;
      refresh_token?: string;
      expires_in: number;
    };
    return {
      accessToken: j.access_token,
      refreshToken: j.refresh_token,
      expiresAt: Date.now() + j.expires_in * 1000,
    };
  };
}

const db = await startTestDb();
try {
  const store = await kvGet<{ accounts: StoredAccount[] }>("accounts");
  const legacy = (store?.accounts ?? []).find(
    (a) => a.email.toLowerCase() === targetEmail,
  );
  if (!legacy) {
    console.error(`no legacy account for ${targetEmail}`);
    process.exit(1);
  }

  const provider: "google" | "microsoft" =
    legacy.provider === "google" ? "google" : "microsoft";
  const userId = await upsertUser(legacy.email);
  const accountId = await upsertAccount({
    userId,
    provider,
    email: legacy.email,
    displayName: legacy.name,
  });
  await saveCredentials(accountId, provider, {
    accessToken: legacy.accessToken,
    refreshToken: legacy.refreshToken,
    expiresAt: legacy.expiresAt,
  });
  console.log(`account migrated: ${legacy.email} (${provider})`);

  const token = await freshAccessToken(accountId, provider, await refreshFor(provider));
  console.log("access token ready");

  const mail: MailProvider =
    provider === "google"
      ? new GmailProvider({ accessToken: token, accountEmail: legacy.email, pageSize: 25 })
      : new OutlookProvider({ accessToken: token, accountEmail: legacy.email, pageSize: 25 });

  // --- Ingest a bounded slice (READ-ONLY) ---
  let cursor: string | null = null;
  let stored = 0;
  let providerTotal = 0;
  let pages = 0;
  while (stored < convoCap && pages < 200) {
    const page = await mail.sync(cursor);
    pages++;
    providerTotal = page.providerTotal;
    const slice = page.conversations.slice(0, convoCap - stored);
    const res = await writeConversationPage(accountId, slice, page.deletedConversationIds);
    stored += res.stored;
    cursor = page.nextCursor;
    if (!cursor) break;
  }
  await saveCursor(accountId, cursor, providerTotal);
  console.log(`ingested ${stored} conversations (provider reports ${providerTotal})`);

  // --- Seed the relationship graph BEFORE reading, so the safety floor can
  // protect real humans (investors, contacts) from being swept. ---
  const key = (legacy.email || "").toLowerCase().trim();
  const [legacyPeople, legacyHistory, legacyPersonal] = await Promise.all([
    kvGet<Record<string, { tier?: string; vip?: boolean; name?: string }>>(`people:${key}`),
    kvGet<{ history?: { contacts?: Record<string, { sentTo?: number }> }; contacts?: Record<string, { sentTo?: number }> }>(`mail-history:${key}`),
    kvGet<{ contacts?: string[] }>(`personal:${key}`),
  ]);
  const seeded = await seedPeople(
    accountId,
    collectPeople({
      people: legacyPeople ?? null,
      history: legacyHistory?.history ?? legacyHistory ?? null,
      contacts: legacyPersonal?.contacts ?? null,
    }),
  );
  console.log(`seeded ${seeded} people into the relationship graph`);

  // --- One chief-of-staff read per conversation ---
  const t0 = Date.now();
  const batch = await readBatch(accountId, legacy.email, defaultReaderModel, {
    limit: convoCap,
    concurrency: 6,
  });
  console.log(
    `read ${batch.attempted} conversations in ${Math.round((Date.now() - t0) / 1000)}s`,
  );

  // --- The resulting inbox view ---
  const view = await buildInboxView(accountId, provider);
  console.log(
    `\ncoverage: stored=${view.coverage.stored} read=${view.coverage.read} pending=${view.coverage.pending}`,
  );
  console.log(
    `atlas=${view.atlas.length} records=${view.records.length} safeToDelete=${view.safeToDelete.length} undecided=${view.undecided.length} worthReading=${view.worthReading.length}\n`,
  );

  // Priority breakdown — the direct-demand vs generic-broadcast distinction.
  console.log("=== NEEDS YOU, SOONEST DUE FIRST (priority 3) ===");
  const hi = await db.pool.query<{
    from_email: string; subject: string; owner: string; due_date: string | null;
  }>(
    `select d.owner, c.subject, d.due_date,
            (select m.from_email from seer.messages m where m.conversation_id = c.id order by m.sent_at desc limit 1) as from_email
       from seer.conversations c join seer.conversation_decisions d on d.conversation_id = c.id and d.is_current
      where d.priority = 3
      order by d.due_date asc nulls last, c.last_message_at desc limit 25`,
  );
  for (const r of hi.rows) {
    const due = r.due_date ? new Date(r.due_date).toISOString().slice(0, 10) : "—";
    console.log(`- due ${due} | ${r.from_email} | ${r.subject.slice(0, 70)}`);
  }

  const dated = await db.pool.query<{ n: number }>(
    "select count(*)::int as n from seer.conversation_decisions where is_current and due_date is not null",
  );
  console.log(`\n(${dated.rows[0].n} conversations carry a stated deadline)`);

  console.log("\n=== Roche sourcing/portal conversations by priority ===");
  const roche = await db.pool.query<{ priority: number; owner: string; from_email: string; subject: string }>(
    `select d.priority, d.owner, c.subject,
            (select m.from_email from seer.messages m where m.conversation_id = c.id order by m.sent_at desc limit 1) as from_email
       from seer.conversations c join seer.conversation_decisions d on d.conversation_id = c.id and d.is_current
      where exists (select 1 from seer.messages m where m.conversation_id = c.id and (m.from_email like '%mybuy@roche.com' or m.from_email like '%vendor.portal@roche.com'))
      order by d.priority desc, c.last_message_at desc`,
  );
  for (const r of roche.rows) console.log(`- P${r.priority} [${r.owner}] ${r.from_email} | ${r.subject.slice(0, 80)}`);

  console.log("\n=== SAFE TO DELETE ===");
  for (const r of view.safeToDelete) {
    console.log(`- ${r.from} | ${r.subject} | ${r.summary}`);
  }

  console.log("\n=== KEPT (undecided / vetoed) ===");
  const vetoed = await db.pool.query<{
    subject: string;
    from_email: string;
    veto_reasons: string[];
    proposed_home: string;
    summary: string;
  }>(
    `select c.subject, d.veto_reasons, d.proposed_home, d.summary,
            (select m.from_email from seer.messages m where m.conversation_id = c.id order by m.sent_at desc limit 1) as from_email
       from seer.conversations c join seer.conversation_decisions d on d.conversation_id = c.id and d.is_current
      where d.home = 'undecided' and array_length(d.veto_reasons,1) > 0`,
  );
  for (const v of vetoed.rows) {
    console.log(
      `- ${v.from_email} | ${v.subject} | proposed=${v.proposed_home} | KEPT because: ${v.veto_reasons.join(", ")}`,
    );
  }

  console.log("\n=== RECORDS ===");
  for (const r of view.records) console.log(`- ${r.from} | ${r.subject}`);

  console.log("\n=== MATTERS ===");
  for (const m of view.atlas) console.log(`- ${m.title} (${m.conversations.length} conversations)`);

  console.log("\n=== YIELDS (meaning kept) ===");
  const ys = await db.pool.query<{ kind: string; headline: string }>(
    "select kind, headline from seer.yields order by kind",
  );
  for (const y of ys.rows) console.log(`- [${y.kind}] ${y.headline}`);
} finally {
  await db.stop();
}
