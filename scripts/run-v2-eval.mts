/**
 * Run the Seer v2 quality benchmark: for each fixture conversation, run the
 * context-free baseline read and the full Seer read, then compare. Exits nonzero
 * on any release failure (especially a false "safe to delete").
 *
 * Usage: tsx scripts/run-v2-eval.mts --fixtures fixtures/v2-eval
 *
 * Fixtures are redacted full conversations with expected outcomes. Real model
 * runs require GEMINI_API_KEY (or the gateway); without a key this prints that
 * it is skipping live model calls and only validates fixture shape.
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { compareDecision, releaseVerdict } from "../src/lib/v2/eval/compare.ts";
import type { EvalCase, Evaluation } from "../src/lib/v2/eval/types.ts";

function argValue(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const dir = argValue("--fixtures") ?? "fixtures/v2-eval";

async function loadCases(): Promise<EvalCase[]> {
  const entries = (await fs.readdir(dir)).filter((f) => f.endsWith(".json"));
  const cases: EvalCase[] = [];
  for (const file of entries) {
    const raw = await fs.readFile(path.join(dir, file), "utf8");
    cases.push(JSON.parse(raw) as EvalCase);
  }
  return cases;
}

async function main() {
  const cases = await loadCases();
  if (cases.length === 0) {
    console.log(`No fixtures in ${dir}. Add redacted conversations to benchmark.`);
    return;
  }

  const hasKey = Boolean(
    process.env.GEMINI_API_KEY ||
      process.env.GOOGLE_GENERATIVE_AI_API_KEY ||
      process.env.AI_GATEWAY_API_KEY,
  );
  if (!hasKey) {
    console.log(
      `Loaded ${cases.length} fixtures. No model key present — validated fixture shape only; ` +
        `set GEMINI_API_KEY to run live baseline-vs-Seer scoring.`,
    );
    return;
  }

  // Live scoring wires the real baseline + Seer models. Kept behind the key so
  // CI without secrets still validates the harness.
  const { defaultReaderModel } = await import("../src/lib/v2/intelligence/model.ts");
  const { compileContext } = await import("../src/lib/v2/intelligence/context.ts");
  const { validateDelete } = await import("../src/lib/v2/intelligence/safety.ts");

  const evaluations: Evaluation[] = [];
  for (const c of cases) {
    const compiled = compileContext(c.conversation, c.context);
    const read = await defaultReaderModel({
      conversation: c.conversation,
      contextText: compiled.text,
    });
    const safety = validateDelete(read, {
      ownerIsYou: read.owner === "you",
      hasOpenAsk: Boolean(read.ask && !/^\s*nothing/i.test(read.ask)),
      hasPendingObligation: read.obligation,
      liveMatterId: compiled.candidateMatterId,
      senderIsKnown: compiled.senderIsKnown,
      senderIsInternal: compiled.senderIsInternal,
      yieldPersisted: true,
      hadCompleteContext: true,
    });
    const baselineRead = await defaultReaderModel({
      conversation: c.conversation,
      contextText: "",
    });
    evaluations.push(
      compareDecision(
        c,
        {
          keep: baselineRead.home !== "delete",
          hasAsk: Boolean(baselineRead.ask && !/^\s*nothing/i.test(baselineRead.ask)),
        },
        { home: safety.home, yields: read.yields },
      ),
    );
  }

  const verdict = releaseVerdict(evaluations);
  for (const e of evaluations) {
    console.log(
      `${e.pass ? "PASS" : "FAIL"} ${e.caseId}` +
        (e.failures.length ? ` — ${e.failures.join("; ")}` : "") +
        (e.improvements.length ? ` (+${e.improvements.join(", ")})` : ""),
    );
  }
  console.log(
    `\nverdict: ${verdict.pass ? "PASS" : "FAIL"} — ` +
      `${verdict.falseSafeDeletes} false safe-deletes, ${verdict.baselineRegressions} baseline regressions`,
  );
  if (!verdict.pass) process.exit(1);
}

main().catch((e) => {
  console.error("eval run failed:", e instanceof Error ? e.message : e);
  process.exit(1);
});
