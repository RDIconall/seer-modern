import {
  ACTION_META,
  type ClassifyDebug,
  type ClassifyExtras,
  type ClassifyResult,
  type Confidence,
  type TriageAction,
} from "@/lib/inbox/classify";
import { historySignals, type MailHistory } from "@/lib/inbox/mail-history";
import {
  contextSignals,
  meetingLabel,
  type PersonalContext,
} from "@/lib/inbox/personal-context";
import type { SeerLabelStore } from "@/lib/mail/seer-labels";
import { intelBreakdown, intelContainsAny } from "@/lib/nlp/intel";
import {
  learnedPrior,
  type ActionMemory,
} from "@/lib/store/action-memory";
import {
  loadDecisions,
  saveDecisions,
  type CachedDecision,
} from "@/lib/store/decision-cache";
import {
  profilePromptBlock,
  type UserProfile,
} from "@/lib/store/user-profile";
import { google } from "@ai-sdk/google";
import { generateText, Output, type LanguageModel } from "ai";
import { z } from "zod";

/**
 * Bump when the prompt/actions change so stale cached decisions
 * are ignored and re-classified.
 */
export const PROMPT_VERSION = 7;

const ACTIONS = [
  "respond",
  "read_and_archive",
  "read_and_delete",
  "delete_now",
  "act_today",
  "unsubscribe",
  "review_subscription",
  "glance_promo",
  "needs_review",
] as const;

const batchSchema = z.object({
  items: z.array(
    z.object({
      id: z.string(),
      action: z.enum(ACTIONS),
      confidence: z.number().min(0).max(1),
      reason: z.string(),
      instruction: z.string(),
    }),
  ),
});

export type GeminiTriageItem = {
  id: string;
  fromEmail: string;
  fromName: string;
  subject: string;
  snippet: string;
  /** Gmail label ids — may carry a saved Seer decision */
  labelIds?: string[];
};

export type DecisionSource = "gemini" | "rules" | "override" | "learned";

export type AssistantClassifyResult = ClassifyResult & {
  source: DecisionSource;
  instruction?: string;
  /** True when served from the persistent decision cache (no API call). */
  cached?: boolean;
};

const BATCH = Math.max(
  5,
  Math.min(40, Number(process.env.SEER_GEMINI_BATCH_SIZE ?? "25") || 25),
);

/**
 * Rules the heuristic engine gets right with near-certainty and where a
 * wrong call is harmless (junk that was getting deleted/unsubscribed
 * anyway). These skip Gemini entirely — zero tokens spent.
 */
const PREFILTER_RULE_IDS = new Set([
  "bulk-delete",
  "bulk-unsubscribe",
  "marketing-cold-delete",
  "marketing-unsubscribe",
  "noreply-cold-delete",
  "shopping-domain",
  "product-notify-promo",
  "product-passive-delete",
  "finance-record-archive",
  "urgency-bait-delete",
  "shipper-status-delete",
]);

/**
 * Model discovery: Google retires model ids (gemini-2.5-flash died for
 * new keys). Ask ListModels which flash models THIS key can use, pick the
 * newest, and cache the answer so it never happens silently again.
 */
let modelMemo: { id: string; ts: number } | null = null;
const MODEL_MEMO_TTL = 6 * 60 * 60 * 1000;

/** Last Gemini failure (module-level) so routes/UI can surface health. */
let lastGeminiError: string | null = null;
let lastGeminiModel: string | null = null;

export function getAssistantStatus(): {
  model: string | null;
  error: string | null;
} {
  return { model: lastGeminiModel, error: lastGeminiError };
}

function scoreModelId(id: string): number {
  // Prefer stable flash models, newest version first
  const m = id.match(/gemini-(\d+(?:\.\d+)?)/);
  const version = m ? parseFloat(m[1]) : 0;
  let score = version * 100;
  if (/flash/.test(id)) score += 50;
  if (/latest/.test(id)) score += 10;
  if (/lite/.test(id)) score -= 20;
  if (/preview|exp/.test(id)) score -= 30;
  if (/tts|image|audio|embed|thinking/.test(id)) score -= 1000;
  return score;
}

async function discoverModelId(googleKey: string): Promise<string> {
  const forced = process.env.SEER_GEMINI_MODEL?.trim();
  if (forced) return forced.replace(/^google\//, "");
  if (modelMemo && Date.now() - modelMemo.ts < MODEL_MEMO_TTL) {
    return modelMemo.id;
  }
  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models?pageSize=200&key=${googleKey}`,
      { cache: "no-store" },
    );
    if (res.ok) {
      const json = (await res.json()) as {
        models?: { name: string; supportedGenerationMethods?: string[] }[];
      };
      const ids = (json.models ?? [])
        .filter((m) =>
          (m.supportedGenerationMethods ?? []).includes("generateContent"),
        )
        .map((m) => m.name.replace(/^models\//, ""));
      const best = ids.sort((a, b) => scoreModelId(b) - scoreModelId(a))[0];
      if (best) {
        modelMemo = { id: best, ts: Date.now() };
        return best;
      }
    }
  } catch {
    /* fall through to alias */
  }
  // Alias Google keeps pointed at the current stable flash model
  return "gemini-flash-latest";
}

export async function resolveAssistantModel(): Promise<{
  model: LanguageModel | string;
  label: string;
}> {
  return resolveModel();
}

async function resolveModel(): Promise<{
  model: LanguageModel | string;
  label: string;
}> {
  const googleKey =
    process.env.GOOGLE_GENERATIVE_AI_API_KEY || process.env.GEMINI_API_KEY;

  // Direct Google Generative AI key (already on this Vercel project)
  if (googleKey) {
    if (!process.env.GOOGLE_GENERATIVE_AI_API_KEY) {
      process.env.GOOGLE_GENERATIVE_AI_API_KEY = googleKey;
    }
    const id = await discoverModelId(googleKey);
    return { model: google(id), label: `google:${id}` };
  }

  // Vercel AI Gateway (OIDC or AI_GATEWAY_API_KEY)
  const gatewayModel =
    process.env.SEER_GEMINI_MODEL?.trim() || "google/gemini-3-flash";
  return { model: gatewayModel, label: gatewayModel };
}

/** True when Gemini can be attempted (Google key, Gateway key, or Vercel OIDC). */
export function isGeminiConfigured(): boolean {
  return Boolean(
    process.env.GEMINI_API_KEY ||
      process.env.GOOGLE_GENERATIVE_AI_API_KEY ||
      process.env.AI_GATEWAY_API_KEY ||
      process.env.VERCEL_OIDC_TOKEN ||
      process.env.VERCEL,
  );
}

function toConfidence(n: number): Confidence {
  if (n >= 0.75) return "HIGH";
  if (n >= 0.45) return "MED";
  return "LOW";
}

function debugFor(
  input: GeminiTriageItem,
  history: MailHistory | null | undefined,
  ruleId: string,
): ClassifyDebug {
  const signals = historySignals(history, input.fromEmail);
  const text = `${input.subject}\n${input.snippet}`;
  const intel = intelBreakdown(text);
  return {
    ruleId,
    relationship: signals.relationship,
    sentTo: signals.sentTo,
    receivedFrom: signals.receivedFrom,
    daysSinceLastSent: signals.daysSinceLastSent,
    staleEngagement: signals.staleEngagement,
    actionable: intelContainsAny(text) || intel.request > 0 || intel.schedule > 0,
    intel,
  };
}

/**
 * Fully static system prompt — byte-identical on every call so Gemini's
 * implicit prompt caching can reuse the prefix. All per-request data goes
 * in the user message (dynamic tail).
 */
const SYSTEM_PROMPT = `You are Seer, an elite email copilot. The user's TIME is more valuable than tokens.

Philosophy: the user's own behavior predicts their next action. Who they email, who is in their contacts, who they are about to meet, and what they did with past mail from a sender all outrank the email's content.

Decide an ACTION for every email. Make the call yourself. Do NOT defer to the user unless something is truly ambiguous AND high-stakes.

Actions:
- respond: a real person is waiting on an answer / decision
- act_today: the user must personally DO something today or lose something — sign, pay, pick up, board, reschedule, enter a code. Time-sensitive is NOT enough: a package "arriving tomorrow" arrives without the user; that is NOT act_today.
- read_and_archive: useful notification/receipt/FYI — skim then archive
- read_and_delete: low-value human or semi-personal noise — skim once then delete
- delete_now: safe to trash without opening (cold promo, bulk noreply junk)
- unsubscribe: mailing list they clearly don't engage with
- review_subscription: billing anomaly / price change / failed charge
- glance_promo: shopping/deals they might want — glance subject only
- needs_review: LAST RESORT (<5% of mail). Only if a wrong auto-action could hurt a real relationship or money and you truly cannot tell.

Input is a JSON array. Item fields: id, from (display name), email, subject, snippet.
Optional predictor fields (omitted when zero/default):
- rel: engaged (user emails them) | known (frequent inbound only) | bulk (automated); sent/recv = message counts; stale = engagement quiet >30d
- contact: true = in the user's address book — a real relationship, never delete_now
- meeting: an upcoming calendar event with this sender (e.g. "Standup · in 2d") — strong signal to respond/act_today
- past: what the user did with recent mail from this sender (e.g. "trashed 2/3") — lean toward repeating their pattern

Priority when signals conflict: meeting > contact > engaged rel > past behavior > content.
USE WORLD KNOWLEDGE of the company behind the email. Airlines = travel. Banks/brokerages = money. Pharmacies/clinics = health. Schools/government = obligations. Judge WHO the company is and WHAT the message means for the user's day — no sent-history is NOT a reason to defer on a recognizable transactional sender.
THE RAZOR — apply to every email: does the user personally have to DO anything? PASSIVE "it happened" mail needs nothing: package shipped/arriving/delivered, order confirmed, ride completed, build passed, PR merged, someone starred/liked/followed, weekly digest, statement ready → delete_now or read_and_delete. The event happens whether they read it or not. NEEDS-THEM mail is the exception: failed delivery/signature/pickup/customs, build FAILED, review requested, mentioned/assigned, security alert, payment failed/fraud/overdue, RSVP/invitation → act_today or respond. Records with future lookup value (receipts, invoices, confirmations with reference numbers) → read_and_archive, never delete.
FAKE URGENCY is the #1 trick: "expires today", "last chance", "action required", "final notice", "reminder:" from bulk/noreply/marketing senders is promo bait — delete_now or glance_promo, NEVER act_today. Urgency is real only from contacts, engaged/known senders, or genuine transactional mail (2FA codes, password resets, security alerts, boarding passes, deliveries, appointments).
Cold noreply marketing → delete_now or unsubscribe.
Product/CI (GitHub, Vercel, Figma, etc.) → usually read_and_archive unless promo.
Be decisive. Prefer a confident archive/delete over needs_review.

Return one item per input id. reason = short why. instruction = what the user should do in one sentence.`;

type CompactItem = {
  id: string;
  from: string;
  email: string;
  subject: string;
  snippet: string;
  rel?: string;
  sent?: number;
  recv?: number;
  stale?: boolean;
  contact?: boolean;
  meeting?: string;
  past?: string;
};

export type TriageExtras = {
  personal?: PersonalContext | null;
  actionMemory?: ActionMemory | null;
  /**
   * The user's "about me" memory — appended to the system prompt so
   * Gemini triages as THIS person. Stable between edits, so Gemini's
   * implicit prompt caching still reuses the shared static prefix.
   */
  profile?: UserProfile | null;
  /** Gmail: read/write decisions as native Seer/<action> labels */
  labels?: SeerLabelStore | null;
  /**
   * Set false for single-message paths (reader/prefetch) — those must be
   * served by cache/label/rules only, never burn API quota one email at
   * a time. Inbox batch loads are the only place Gemini is called.
   */
  geminiEnabled?: boolean;
};

function compactPayload(
  batch: GeminiTriageItem[],
  history: MailHistory | null | undefined,
  extras?: TriageExtras,
): CompactItem[] {
  return batch.map((m) => {
    const sig = historySignals(history, m.fromEmail);
    const item: CompactItem = {
      id: m.id,
      from: (m.fromName || m.fromEmail).slice(0, 60),
      email: m.fromEmail,
      subject: m.subject.slice(0, 140),
      snippet: m.snippet.slice(0, 400),
    };
    if (sig.relationship !== "cold") item.rel = sig.relationship;
    if (sig.sentTo > 0) item.sent = sig.sentTo;
    if (sig.receivedFrom > 0) item.recv = sig.receivedFrom;
    if (sig.staleEngagement) item.stale = true;

    const ctx = contextSignals(extras?.personal, m.fromEmail);
    if (ctx.inContacts) item.contact = true;
    const meet = meetingLabel(ctx.meeting);
    if (meet) item.meeting = meet;

    const stat = extras?.actionMemory?.[m.fromEmail.toLowerCase().trim()];
    if (stat && stat.archive + stat.trash > 0) {
      const total = stat.archive + stat.trash;
      item.past =
        stat.trash >= stat.archive
          ? `trashed ${stat.trash}/${total}`
          : `archived ${stat.archive}/${total}`;
    }
    return item;
  });
}

async function geminiBatch(
  batch: GeminiTriageItem[],
  history: MailHistory | null | undefined,
  extras?: TriageExtras,
): Promise<Map<string, AssistantClassifyResult>> {
  const out = new Map<string, AssistantClassifyResult>();
  if (batch.length === 0) return out;

  const payload = compactPayload(batch, history, extras);
  const { model, label } = await resolveModel();
  // Static prompt first (implicit-cache prefix), then the user's own
  // "about me" memory — identical bytes call to call until they edit it.
  const profileBlock = profilePromptBlock(extras?.profile);
  const system = profileBlock
    ? `${SYSTEM_PROMPT}\n\n${profileBlock}`
    : SYSTEM_PROMPT;
  const { output } = await generateText({
    model,
    temperature: 0,
    maxRetries: 1, // don't burn rate-limited quota on rapid retries
    output: Output.object({ schema: batchSchema }),
    system,
    prompt: JSON.stringify(payload),
  });

  lastGeminiModel = label;
  lastGeminiError = null;

  if (!output?.items?.length) return out;

  for (const row of output.items) {
    const src = batch.find((b) => b.id === row.id);
    if (!src) continue;
    let action = row.action as TriageAction;
    // Soften: if model picks needs_review with medium+ confidence, force a decisive default
    if (action === "needs_review" && row.confidence >= 0.55) {
      const sig = historySignals(history, src.fromEmail);
      action =
        sig.relationship === "engaged" ? "respond" : "read_and_delete";
    }
    out.set(row.id, {
      action,
      confidence: toConfidence(row.confidence),
      reason: row.reason.slice(0, 200),
      debug: debugFor(src, history, `gemini:${label}`),
      source: "gemini",
      instruction: row.instruction.slice(0, 200),
    });
  }
  return out;
}

function toCached(r: AssistantClassifyResult): CachedDecision {
  return {
    action: r.action,
    confidence: r.confidence,
    reason: r.reason,
    instruction: r.instruction,
    source: r.source,
    ruleId: r.debug.ruleId,
    ts: Date.now(),
    v: PROMPT_VERSION,
  };
}

/**
 * Behavior-first triage for an inbox list. Precedence:
 * 1. Taught overrides — the user explicitly told us (free).
 * 2. Learned priors — the user's own repeated archive/trash actions on
 *    a sender ARE the classifier (free, and self-correcting).
 * 3. Persistent decision cache — already-classified mail costs zero tokens.
 * 4. Native Gmail labels — Gemini reviewed once, its call was saved as a
 *    Seer/<action> label on the message itself (free, survives restarts).
 * 5. Rules pre-filter — obvious junk decided locally without an API call
 *    (never for contacts or people you're about to meet).
 * 6. Gemini decides the gray zone, fed relationship + contacts + calendar
 *    + past-action predictors, in large batches with a static system
 *    prompt (implicit prompt caching) and trimmed payloads. New calls are
 *    written back as Gmail labels so they're never paid for again.
 * 7. Rules fallback if Gemini is unavailable or misses an id.
 */
export async function classifyInboxWithAssistant(
  accountEmail: string,
  items: GeminiTriageItem[],
  history: MailHistory | null | undefined,
  getOverride: (email: string) => Promise<TriageAction | null> | TriageAction | null,
  rulesFallback: (
    input: {
      fromEmail: string;
      fromName?: string;
      subject: string;
      snippet: string;
    },
    override: TriageAction | null,
    history: MailHistory | null | undefined,
    classifyExtras?: ClassifyExtras,
  ) => ClassifyResult,
  extras?: TriageExtras,
): Promise<Map<string, AssistantClassifyResult>> {
  const results = new Map<string, AssistantClassifyResult>();
  const candidates: GeminiTriageItem[] = [];

  // 1. Taught overrides + 2. learned priors from the user's own actions
  for (const item of items) {
    const override = await getOverride(item.fromEmail);
    if (override) {
      results.set(item.id, {
        action: override,
        confidence: "HIGH",
        reason: "You taught this sender",
        debug: debugFor(item, history, "override-taught-sender"),
        source: "override",
        instruction: ACTION_META[override].label,
      });
      continue;
    }

    const learned = learnedPrior(extras?.actionMemory, item.fromEmail);
    if (learned) {
      const verb = learned.dominant === "trash" ? "deleted" : "archived";
      results.set(item.id, {
        action: learned.action,
        confidence: "HIGH",
        reason: `You ${verb} ${learned.count} of the last ${learned.total} from this sender`,
        debug: debugFor(item, history, `learned-${learned.dominant}`),
        source: "learned",
        instruction:
          learned.dominant === "trash"
            ? "Seer learned you always trash this sender — safe to delete."
            : "Seer learned you always archive this sender — skim then archive.",
      });
      continue;
    }

    candidates.push(item);
  }

  // 3. Persistent decision cache
  const cachedHits = await loadDecisions(
    accountEmail,
    candidates.map((c) => c.id),
    PROMPT_VERSION,
  ).catch(() => new Map<string, CachedDecision>());

  const forGemini: GeminiTriageItem[] = [];
  const toSave = new Map<string, CachedDecision>();

  for (const item of candidates) {
    const hit = cachedHits.get(item.id);
    if (hit) {
      results.set(item.id, {
        action: hit.action,
        confidence: hit.confidence,
        reason: hit.reason,
        instruction: hit.instruction,
        debug: debugFor(item, history, hit.ruleId),
        source: hit.source,
        cached: true,
      });
      continue;
    }

    const ctx = contextSignals(extras?.personal, item.fromEmail);
    const classifyExtras: ClassifyExtras = {
      inContacts: ctx.inContacts,
      meeting: meetingLabel(ctx.meeting),
    };

    // 4. Native Gmail label: reviewed once earlier, call saved on the message.
    // Exception: an "urgent" label on a non-person sender (bulk/known robot,
    // not a contact, no meeting) may be an older prompt's mistake — re-review.
    // Also skipped briefly after the user edits their "about me" memory so
    // new self-knowledge gets applied to already-labeled mail once.
    const profileFresh =
      extras?.profile &&
      Date.now() - new Date(extras.profile.updatedAt).getTime() <
        30 * 60 * 1000;
    const labeled = profileFresh ? null : extras?.labels?.lookup(item);
    if (labeled) {
      const rel = historySignals(history, item.fromEmail).relationship;
      const suspiciousUrgent =
        (labeled === "act_today" || labeled === "respond") &&
        !ctx.inContacts &&
        !ctx.meeting &&
        rel !== "engaged";
      if (!suspiciousUrgent) {
        results.set(item.id, {
          action: labeled,
          confidence: "HIGH",
          reason: "Reviewed earlier — decision saved as a Gmail label",
          debug: debugFor(item, history, `label:Seer/${labeled}`),
          source: "gemini",
          cached: true,
        });
        continue;
      }
    }

    // 5. Rules pre-filter: obvious junk never reaches Gemini — but a
    // contact or someone you're meeting soon is never junk.
    if (!ctx.inContacts && !ctx.meeting) {
      const ruled = rulesFallback(
        {
          fromEmail: item.fromEmail,
          fromName: item.fromName,
          subject: item.subject,
          snippet: item.snippet,
        },
        null,
        history,
        classifyExtras,
      );
      if (PREFILTER_RULE_IDS.has(ruled.debug.ruleId)) {
        const r: AssistantClassifyResult = {
          ...ruled,
          source: "rules",
          debug: { ...ruled.debug, ruleId: `rules:${ruled.debug.ruleId}` },
        };
        results.set(item.id, r);
        toSave.set(item.id, toCached(r));
        continue;
      }
    }

    forGemini.push(item);
  }

  // 6. Gemini for the gray zone (batch loads only — see geminiEnabled)
  if (
    forGemini.length > 0 &&
    isGeminiConfigured() &&
    extras?.geminiEnabled !== false
  ) {
    try {
      for (let i = 0; i < forGemini.length; i += BATCH) {
        const chunk = forGemini.slice(i, i + BATCH);
        const mapped = await geminiBatch(chunk, history, extras);
        for (const [id, r] of mapped) {
          results.set(id, r);
          toSave.set(id, toCached(r));
        }
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      lastGeminiError = msg.slice(0, 300);
      // A dead model id may be memoized — forget it so the next load
      // rediscovers instead of failing forever.
      if (/no longer available|not found|NOT_FOUND/i.test(msg)) {
        modelMemo = null;
      }
      console.error("[seer] Gemini triage failed, falling back to rules:", msg);
    }
  }

  // 7. Rules fallback for anything Gemini missed (not cached, so Gemini
  //    gets another shot on the next load)
  for (const item of forGemini) {
    if (results.has(item.id)) continue;
    const ctx = contextSignals(extras?.personal, item.fromEmail);
    const r = rulesFallback(
      {
        fromEmail: item.fromEmail,
        fromName: item.fromName,
        subject: item.subject,
        snippet: item.snippet,
      },
      null,
      history,
      { inContacts: ctx.inContacts, meeting: meetingLabel(ctx.meeting) },
    );
    results.set(item.id, {
      ...r,
      source: "rules",
      debug: { ...r.debug, ruleId: `rules:${r.debug.ruleId}` },
    });
  }

  await saveDecisions(accountEmail, toSave).catch(() => {});

  // Save fresh calls as native Gmail labels — reviewed once, never re-paid
  if (extras?.labels && toSave.size > 0) {
    const labelWrites = [...toSave.entries()].map(([id, d]) => ({
      id,
      action: d.action,
    }));
    await extras.labels.persist(labelWrites).catch(() => {});
  }

  return results;
}
