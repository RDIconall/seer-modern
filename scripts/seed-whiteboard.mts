/**
 * Idempotent seed of Conall's Oct 30 CEO Whiteboard.
 *
 *   npx tsx scripts/seed-whiteboard.mts --email conall@rditrials.com
 *
 * Uses SEER_V2_DATABASE_URL / POSTGRES_URL. Additive: never drops existing
 * items. Safe to re-run. Do not point this at production from an unreviewed PR.
 */
import { db } from "../src/lib/v2/db/pool.ts";
import { asAccountId } from "../src/lib/v2/db/types.ts";
import { loadWhiteboardView } from "../src/lib/v2/whiteboard/repository.ts";

function arg(name: string): string | null {
  const prefix = `--${name}=`;
  const matched = process.argv.find((value) => value.startsWith(prefix));
  if (matched) return matched.slice(prefix.length);
  const at = process.argv.indexOf(`--${name}`);
  if (at >= 0) return process.argv[at + 1] ?? null;
  return null;
}

async function resolveAccountId(email: string | null): Promise<string> {
  if (email) {
    const r = await db().query<{ id: string; email: string }>(
      "select id, email from seer.mail_accounts where lower(email) = lower($1) limit 1",
      [email],
    );
    if (!r.rows[0]) {
      throw new Error(`no mail account for ${email}`);
    }
    return r.rows[0].id;
  }
  const r = await db().query<{ id: string; email: string }>(
    "select id, email from seer.mail_accounts order by created_at limit 2",
  );
  if (r.rowCount === 0) throw new Error("no mail accounts in seer.mail_accounts");
  if ((r.rowCount ?? 0) > 1) {
    throw new Error("multiple mail accounts — pass --email");
  }
  console.log(`seeding ${r.rows[0].email}`);
  return r.rows[0].id;
}

const email = arg("email");
const accountId = asAccountId(await resolveAccountId(email));
const view = await loadWhiteboardView(accountId);
const items = view.sections.reduce((n, section) => n + section.items.length, 0);
console.log(
  `whiteboard ${view.persisted ? "persisted" : "local-only"} · ${view.sections.length} sections · ${items} items`,
);
process.exit(0);
