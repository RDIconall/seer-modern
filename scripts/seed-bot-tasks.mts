/**
 * Idempotent seed of delegated bot tasks from a CSV export.
 *
 *   npx tsx scripts/seed-bot-tasks.mts --csv /private/path/bot_tasks.csv --email <mailbox>
 *
 * The real export holds internal finance, HR and vendor details, so it must
 * live outside this (public) repository. Pass it with --csv or
 * SEER_BOT_TASKS_CSV. fixtures/bot_tasks.sample.csv is synthetic test data.
 *
 * Uses SEER_V2_DATABASE_URL / POSTGRES_URL. Never pointed at production by this
 * PR — run against preview or a local database.
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { db } from "../src/lib/v2/db/pool.ts";
import { asAccountId } from "../src/lib/v2/db/types.ts";
import { tasksFromCsv } from "../src/lib/v2/staff/seed.ts";
import { upsertSeedTask } from "../src/lib/v2/staff/repository.ts";

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

const csvPath = arg("csv") ?? process.env.SEER_BOT_TASKS_CSV?.trim() ?? "";
if (!csvPath) {
  throw new Error(
    "pass --csv <path> or set SEER_BOT_TASKS_CSV (keep the real export outside the repo)",
  );
}
const email = arg("email");
const csv = await fs.readFile(csvPath, "utf8");
const rows = tasksFromCsv(csv);
if (rows.length === 0) throw new Error(`${csvPath} had no tasks`);

const accountId = asAccountId(await resolveAccountId(email));
let upserts = 0;
for (const row of rows) {
  await upsertSeedTask({
    accountId,
    botSlug: row.botSlug,
    botName: row.botName,
    externalKey: row.externalKey,
    title: row.title,
    status: row.status,
    priority: row.priority,
    notes: row.nextAction,
    hisWords: row.hisWords,
    currentState: row.currentState,
    nextAction: row.nextAction,
    source: "bot",
    createdAt: row.dateAsked ? `${row.dateAsked}T12:00:00.000Z` : null,
  });
  upserts += 1;
}

console.log(`seeded ${upserts} bot tasks from ${path.basename(csvPath)}`);
process.exit(0);
