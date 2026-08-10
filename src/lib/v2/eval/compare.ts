import type {
  BaselineResult,
  EvalCase,
  Evaluation,
  ReleaseVerdict,
  SeerOutcome,
} from "./types";

/**
 * Compare one Seer outcome against the baseline and the expected result. The
 * cardinal sin is a false "safe to delete": actionable or valuable mail landing
 * in delete. The second is a regression against the naive baseline: the baseline
 * would keep it, but Seer deletes it. Fabricated connections and missing yields
 * also fail. Correct business connections the baseline could not make are counted
 * as improvements — the app earning its keep.
 */

export function compareDecision(
  evalCase: EvalCase,
  baseline: BaselineResult,
  seer: SeerOutcome,
): Evaluation {
  const failures: string[] = [];
  const improvements: string[] = [];

  // 1. False safe-delete — the highest-cost error.
  if (evalCase.expectedHome !== "delete" && seer.home === "delete") {
    failures.push(
      `false_safe_delete: expected ${evalCase.expectedHome}, got delete`,
    );
  }

  // 2. Regression vs the naive baseline: it would keep this, Seer deletes it.
  if ((baseline.keep || baseline.hasAsk) && seer.home === "delete") {
    failures.push("baseline_regression: baseline would keep, Seer deletes");
  }

  // 3. Fabricated matter connection — a claim with no allowed referent.
  const allowed = new Set(
    (evalCase.allowedMatterRefs ?? []).map((r) => r.toLowerCase()),
  );
  for (const y of seer.yields) {
    if (y.kind === "matter_connection") {
      const ref = (y.matterRef ?? "").toLowerCase();
      if (!ref || !allowed.has(ref)) {
        failures.push(`fabricated_connection: ${y.matterRef ?? "(none)"}`);
      }
    }
  }

  // 4. Missing required yields.
  const seerKinds = new Set(seer.yields.map((y) => y.kind));
  for (const kind of evalCase.requiredYieldKinds ?? []) {
    if (!seerKinds.has(kind)) failures.push(`missing_yield: ${kind}`);
  }

  // Improvement: a correct matter connection the baseline (no context) could
  // not have made.
  if (
    !baseline.keep &&
    seer.yields.some(
      (y) => y.kind === "matter_connection" && allowed.has((y.matterRef ?? "").toLowerCase()),
    )
  ) {
    improvements.push("added_correct_business_connection");
  }

  return {
    caseId: evalCase.id,
    pass: failures.length === 0,
    failures,
    improvements,
  };
}

export function releaseVerdict(evaluations: Evaluation[]): ReleaseVerdict {
  const falseSafeDeletes = evaluations.filter((e) =>
    e.failures.some((f) => f.startsWith("false_safe_delete")),
  ).length;
  const baselineRegressions = evaluations.filter((e) =>
    e.failures.some((f) => f.startsWith("baseline_regression")),
  ).length;
  return {
    pass: evaluations.every((e) => e.pass),
    evaluations,
    falseSafeDeletes,
    baselineRegressions,
  };
}
