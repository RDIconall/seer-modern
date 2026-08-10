import type { ReleaseVerdict } from "../eval/types";

/**
 * The cutover gate. v2 runs in read-only shadow on the full corpus; this decides
 * whether it has earned the right to take over an account. The gate is
 * deliberately strict: any pending/failed coverage, any false "safe to delete",
 * any provider-parity failure, any missing native link, any unpersisted yield,
 * or ANY provider mutation issued from shadow mode blocks cutover.
 */

export type ShadowReport = {
  account: string;
  coverage: { providerTotal: number; stored: number; read: number; pending: number; failed: number };
  benchmark: ReleaseVerdict | null;
  providerParityPassed: boolean;
  missingNativeLinks: number;
  unpersistedYields: number;
  /** Provider mutations attempted during shadow — MUST be zero. */
  shadowMutations: number;
};

export type CutoverDecision = {
  eligible: boolean;
  blockers: string[];
};

export function cutoverEligible(report: ShadowReport): CutoverDecision {
  const blockers: string[] = [];

  if (report.coverage.pending > 0) {
    blockers.push(`coverage_pending:${report.coverage.pending}`);
  }
  if (report.coverage.failed > 0) {
    blockers.push(`coverage_failed:${report.coverage.failed}`);
  }
  if (!report.benchmark) {
    blockers.push("benchmark_missing");
  } else {
    if (!report.benchmark.pass) blockers.push("benchmark_failed");
    if (report.benchmark.falseSafeDeletes > 0) {
      blockers.push(`false_safe_deletes:${report.benchmark.falseSafeDeletes}`);
    }
    if (report.benchmark.baselineRegressions > 0) {
      blockers.push(`baseline_regressions:${report.benchmark.baselineRegressions}`);
    }
  }
  if (!report.providerParityPassed) blockers.push("provider_parity_failed");
  if (report.missingNativeLinks > 0) {
    blockers.push(`missing_native_links:${report.missingNativeLinks}`);
  }
  if (report.unpersistedYields > 0) {
    blockers.push(`unpersisted_yields:${report.unpersistedYields}`);
  }
  if (report.shadowMutations > 0) {
    // Shadow must never touch the mailbox. A single mutation is disqualifying.
    blockers.push(`shadow_mutations:${report.shadowMutations}`);
  }

  return { eligible: blockers.length === 0, blockers };
}
