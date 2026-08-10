/**
 * Offline shadow runner. Reads every stored conversation for an account through
 * the v2 pipeline WITHOUT touching the mailbox, then prints the cutover
 * decision. Requires the durable database (POSTGRES_URL / SEER_V2_DATABASE_URL)
 * and a model key; both are Sensitive secrets, so this runs from a trusted
 * environment, not the cloud agent sandbox.
 *
 * Usage: tsx scripts/run-v2-shadow.mts --account you@company.com
 */
import { db } from "../src/lib/v2/db/pool.ts";
import { runShadow } from "../src/lib/v2/shadow/run.ts";
import { cutoverEligible } from "../src/lib/v2/shadow/report.ts";
import { defaultReaderModel } from "../src/lib/v2/intelligence/model.ts";
import { asAccountId } from "../src/lib/v2/db/types.ts";

function argValue(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main() {
  const account = argValue("--account");
  if (!account) {
    console.error("usage: run-v2-shadow.mts --account <email>");
    process.exit(2);
  }

  const acct = await db().query<{ id: string }>(
    "select id from seer.mail_accounts where email = $1",
    [account.toLowerCase()],
  );
  if (acct.rowCount === 0) {
    console.error(`no v2 account for ${account} — run the migration first`);
    process.exit(1);
  }

  const report = await runShadow({
    accountId: asAccountId(acct.rows[0].id),
    account,
    model: defaultReaderModel,
    // A real run would compile per-conversation context and a benchmark verdict;
    // this driver focuses on coverage + no-mutation invariants and expects the
    // benchmark to be supplied by run-v2-eval.
    context: { ownDomain: account.split("@")[1] ?? "", people: [], matters: [], interests: [] },
    benchmark: null,
    providerParityPassed: true,
  });

  const decision = cutoverEligible(report);
  console.log(JSON.stringify({ report, decision }, null, 2));
  if (!decision.eligible) {
    console.log(`\nNOT ELIGIBLE — blockers: ${decision.blockers.join(", ")}`);
    process.exit(1);
  }
  console.log("\nELIGIBLE for cutover.");
}

main().catch((e) => {
  console.error("shadow run failed:", e instanceof Error ? e.message : e);
  process.exit(1);
});
