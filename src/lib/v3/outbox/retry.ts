import { ProviderHttpError } from "@/lib/v2/providers/http";
import { isProviderReconcileError } from "@/lib/v2/providers/mutation-idempotent";

/** How a provider/drain error should be handled. */
export type RetryDisposition = "transient" | "permanent" | "reconcile";

const TRANSIENT_STATUSES = new Set([408, 429, 500, 502, 503, 504]);

function httpStatus(err: unknown): number | null {
  if (err instanceof ProviderHttpError) return err.status;
  if (
    typeof err === "object" &&
    err !== null &&
    "status" in err &&
    typeof (err as { status: unknown }).status === "number"
  ) {
    return (err as { status: number }).status;
  }
  return null;
}

/**
 * Classify provider errors for outbox drain. Permanent auth/permission failures
 * fail immediately without consuming retry budget. Transient network/429/5xx
 * errors backoff. Ambiguous cases that need provider reconciliation are flagged
 * separately.
 */
export function classifyDrainError(err: unknown): RetryDisposition {
  if (isProviderReconcileError(err)) return "reconcile";
  const status = httpStatus(err);
  if (status !== null) {
    if (status === 401 || status === 403) return "permanent";
    if (status === 404) return "reconcile";
    if (TRANSIENT_STATUSES.has(status)) return "transient";
    if (status >= 500) return "transient";
    if (status === 400) return "permanent";
    return "reconcile";
  }
  const message = err instanceof Error ? err.message.toLowerCase() : "";
  if (
    message.includes("timeout") ||
    message.includes("econnreset") ||
    message.includes("network") ||
    message.includes("aborted")
  ) {
    return "transient";
  }
  if (message.includes("unauthorized") || message.includes("forbidden")) {
    return "permanent";
  }
  return "transient";
}
