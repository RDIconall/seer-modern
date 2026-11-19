import { kvGet, kvSet } from "@/lib/store/kv";
import { asAccountId, isUuid } from "@/lib/v2/db/types";
import {
  reserveModelUsage,
  settleModelUsage,
} from "@/lib/v2/intelligence/model-usage";

/**
 * Quota cooldown, shared across serverless instances via KV: when Google
 * says "quota exceeded", every retry is a wasted request — stop calling
 * until the window resets instead of failing on each load.
 */
export const COOLDOWN_KEY = "gemini-cooldown";
export type Cooldown = { until: number; reason: string };

export function cooldownFromError(msg: string): Cooldown | null {
  if (!/quota|rate limit|429|RESOURCE_EXHAUSTED/i.test(msg)) return null;
  // Daily cap → sleep until the next Pacific midnight (Google's reset)
  if (/PerDay|per day|daily/i.test(msg)) {
    const now = new Date();
    const reset = new Date(now);
    reset.setUTCHours(7, 5, 0, 0); // 07:05 UTC ≈ just past midnight PT
    if (reset <= now) reset.setUTCDate(reset.getUTCDate() + 1);
    return {
      until: reset.getTime(),
      reason: "Daily free-tier quota used — resumes after midnight PT",
    };
  }
  // Per-minute cap → honor Google's suggested retry delay when present
  const m = msg.match(/retry(?:Delay|\s+in)["\s:]*([\d.]+)\s*s/i);
  const seconds = m ? Math.ceil(parseFloat(m[1])) + 5 : 10 * 60;
  return {
    until: Date.now() + seconds * 1000,
    reason: "Rate limit hit — cooling down",
  };
}

export type LegacyModelPurpose =
  | "draft"
  | "unsub-agent"
  | "triage"
  | "brief"
  | "understanding";

/** Interactive routes a signed-in mailbox can hit in a loop. */
const ROUTE_PURPOSES: LegacyModelPurpose[] = ["draft", "unsub-agent"];

/** Every legacy pass runs on a flash-class model. */
const LEGACY_TIER = "fast" as const;

export type LegacyModelBudget = {
  /** The mailbox account the call is billed to. */
  accountId: string | null | undefined;
  purpose: LegacyModelPurpose;
};

/** The call was refused before any provider request was sent. */
export class ModelBudgetError extends Error {
  readonly status: 429 | 503;
  constructor(message: string, status: 429 | 503 = 429) {
    super(message);
    this.name = "ModelBudgetError";
    this.status = status;
  }
}

const tag = (purpose: LegacyModelPurpose) => `legacy:${purpose}`;

function accountCooldownKey(accountId: string): string {
  return `${COOLDOWN_KEY}:account:${accountId}`;
}

function routePerMinuteLimit(): number {
  return Number(process.env.SEER_LEGACY_ROUTE_PER_MINUTE ?? 8);
}

async function reserve(
  budget: LegacyModelBudget,
  model: string,
): Promise<string> {
  const { accountId, purpose } = budget;
  if (!accountId || !isUuid(accountId)) {
    throw new ModelBudgetError(
      "Assistant unavailable: no mailbox account to bill this call to",
      503,
    );
  }
  // The account that tripped the shared key's quota sits out the whole
  // window, including the gateway, so it cannot keep spending.
  const blocked = await kvGet<Cooldown>(accountCooldownKey(accountId)).catch(
    () => null,
  );
  if (blocked && blocked.until > Date.now()) {
    const mins = Math.ceil((blocked.until - Date.now()) / 60000);
    throw new ModelBudgetError(`${blocked.reason} (~${mins}m)`, 429);
  }
  let reservation: Awaited<ReturnType<typeof reserveModelUsage>>;
  try {
    reservation = await reserveModelUsage(
      {
        accountId: asAccountId(accountId),
        tier: LEGACY_TIER,
        model,
        escalationReasons: [tag(purpose)],
      },
      ROUTE_PURPOSES.includes(purpose)
        ? {
            tags: ROUTE_PURPOSES.map(tag),
            seconds: 60,
            limit: routePerMinuteLimit(),
          }
        : undefined,
    );
  } catch (error) {
    console.error(
      "[seer] model budget reservation failed:",
      error instanceof Error ? error.message : error,
    );
    throw new ModelBudgetError(
      "Assistant unavailable: could not check this mailbox's model budget",
      503,
    );
  }
  if (!reservation.ok) {
    throw new ModelBudgetError(
      reservation.reason === "rate_limit"
        ? "Too many assistant requests — wait a minute and try again"
        : "This mailbox reached its daily assistant budget",
      429,
    );
  }
  return reservation.id;
}

type ProviderResult = {
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
    outputTokenDetails?: { reasoningTokens?: number };
    inputTokenDetails?: { cacheReadTokens?: number };
  };
  providerMetadata?: Record<string, unknown>;
};

async function settle(id: string, latencyMs: number, result: unknown) {
  const r = (result ?? {}) as ProviderResult;
  const gateway = r.providerMetadata?.gateway as
    | Record<string, unknown>
    | undefined;
  const cost = Number(gateway?.cost);
  try {
    await settleModelUsage(id, {
      latencyMs,
      inputTokens: r.usage?.inputTokens,
      outputTokens: r.usage?.outputTokens,
      reasoningTokens: r.usage?.outputTokenDetails?.reasoningTokens,
      cachedInputTokens: r.usage?.inputTokenDetails?.cacheReadTokens,
      totalTokens: r.usage?.totalTokens,
      gatewayGenerationId:
        typeof gateway?.generationId === "string"
          ? gateway.generationId
          : undefined,
      costUsd: gateway?.cost !== undefined && Number.isFinite(cost) ? cost : undefined,
    });
  } catch (error) {
    console.error(
      "[seer] model usage settle failed:",
      error instanceof Error ? error.message : error,
    );
  }
}

async function noteProviderError(
  accountId: string,
  label: string,
  error: unknown,
) {
  const msg = error instanceof Error ? error.message : String(error);
  const cd = cooldownFromError(msg);
  if (!cd) return;
  const ttlSeconds = Math.max(1, Math.ceil((cd.until - Date.now()) / 1000));
  await kvSet(accountCooldownKey(accountId), cd, { ttlSeconds }).catch(
    () => {},
  );
  // Only a quota answer from the shared direct key moves other mailboxes
  // to the gateway.
  if (label.startsWith("google:")) {
    await kvSet(COOLDOWN_KEY, cd).catch(() => {});
  }
}

/**
 * Run one legacy model call against the caller's daily budget. The usage
 * row is committed before `run` starts; a refusal throws ModelBudgetError
 * without contacting the provider. `run` must make exactly one provider
 * request (pass maxRetries: 0).
 */
export async function withModelBudget<R>(
  budget: LegacyModelBudget,
  label: string,
  run: () => Promise<R>,
): Promise<R> {
  const usageId = await reserve(budget, label);
  const started = Date.now();
  let result: R;
  try {
    result = await run();
  } catch (error) {
    await settle(usageId, Date.now() - started, undefined);
    await noteProviderError(budget.accountId as string, label, error);
    throw error;
  }
  await settle(usageId, Date.now() - started, result);
  return result;
}
