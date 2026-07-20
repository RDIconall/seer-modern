import {
  ACTION_META,
  needsYouEscape,
  type ClassifyDebug,
  type ClassifyExtras,
  type ClassifyResult,
  type Confidence,
  type TriageAction,
} from "@/lib/inbox/classify";
import { historySignals, type MailHistory } from "@/lib/inbox/mail-history";
import {
  contextSignals,
  inviteSignals,
  meetingLabel,
  RSVP_RECEIPT_SUBJECT,
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
import { kvGet, kvSet } from "@/lib/store/kv";
import {
  loadPeople,
  savePeople,
  tierFromEvidence,
  type PeopleDb,
  type PersonTier,
} from "@/lib/store/people";
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
export const PROMPT_VERSION = 18;

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
      /** The implied action / specific fact headline — or "none" */
      task: z.string().optional(),
      /** Life bucket in the user's language, staleness-aware */
      category: z.string().optional(),
      /** THE MAIN FILTER: human writing personally, or a machine? */
      sender: z.enum(["person", "machine"]).optional(),
      /** For unknown people only: a real, credible person worth attention? */
      credible: z.boolean().optional(),
      /** 0 noise · 1 marginal · 2 relevant · 3 critical */
      importance: z.number().min(0).max(3).optional(),
      /** The specific thing only the user can do, or "none" */
      deed: z.string().optional(),
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
  /** Thread + arrival time — used to spot "you already replied" */
  threadId?: string;
  receivedAt?: string;
};

export type DecisionSource = "gemini" | "rules" | "override" | "learned";

export type AssistantClassifyResult = ClassifyResult & {
  source: DecisionSource;
  instruction?: string;
  /** The implied action — imperative ("Fix the autopay payment") or "Be aware: …" */
  task?: string;
  /** Life bucket in the user's language ("Old trip", "Groceries — delivered") */
  category?: string;
  /** Main-filter verdict from the AI's full-text read */
  senderKind?: "person" | "machine";
  credible?: boolean;
  /** 0 noise · 1 marginal · 2 relevant · 3 critical */
  importance?: number;
  /** The specific deed, or "none" */
  deed?: string;
  /** True when served from the persistent decision cache (no API call). */
  cached?: boolean;
};

function ageInDays(receivedAt?: string): number {
  if (!receivedAt) return 0;
  const t = new Date(receivedAt).getTime();
  if (Number.isNaN(t)) return 0;
  return Math.floor((Date.now() - t) / (24 * 60 * 60 * 1000));
}

/**
 * Urgency that EXPIRES: once the moment passes, the email is a fossil.
 * (Persistent obligations — unpaid bill, unsigned doc — never match.)
 */
const EXPIRING_URGENCY =
  /(check.?in|boarding|departs|departure|your (flight|trip)|deliver(y|ing|ed)? (today|tomorrow)|arriv(es|ing) (today|tomorrow)|out for delivery|verification code|one.?time (code|passcode)|security code|expires? (today|tonight|in \d+ (hours?|minutes?))|starts (today|tonight|soon)|happening (today|now)|(today|tonight) only|last day to|ends (today|tonight)|webinar|livestream|rsvp by|doors open)/i;

/** Codes die in minutes; travel/events die once the day passes. */
const FAST_EXPIRE =
  /(verification code|one.?time (code|passcode)|security code|log.?in code)/i;

/**
 * Post-guard over EVERY decision source (cache, Gmail labels, Gemini,
 * rules): an act_today from days ago whose moment has passed is dead.
 * This is how a flight check-in stops screaming after the flight.
 */
function applyUrgencyDecay(
  item: GeminiTriageItem,
  result: AssistantClassifyResult,
  history: MailHistory | null | undefined,
): AssistantClassifyResult {
  if (result.action !== "act_today") return result;
  const age = ageInDays(item.receivedAt);
  if (age < 1) return result;
  const hay = `${item.subject} ${item.snippet}`;
  const expiring = EXPIRING_URGENCY.test(hay);
  const fast = FAST_EXPIRE.test(hay);
  if (!(fast && age >= 1) && !(expiring && age >= 2)) return result;
  return {
    action: "delete_now",
    confidence: "HIGH",
    reason: `Was urgent when it arrived — the moment passed ${age}d ago`,
    debug: { ...debugFor(item, history, "urgency-expired"), ruleId: "urgency-expired" },
    source: result.source,
    instruction: "This expired on its own. Safe to delete without opening.",
    task: "Nothing — it expired",
  };
}

/** Looks like a record worth keeping (used to trust old archive labels). */
const RECORD_HINT =
  /(receipt|invoice|statement|confirm(?:ed|ation)|order\s*(?:#|no|number)|reference|booking|itinerary|ticket|policy|tax|W-?2|1099)/i;

// Free-tier Gemini caps REQUESTS per day, not emails — bigger batches
// stretch the same quota over more mail.
const BATCH = Math.max(
  5,
  Math.min(40, Number(process.env.SEER_GEMINI_BATCH_SIZE ?? "40") || 40),
);

/**
 * Whole-email reads are ~10x the tokens of snippets — smaller chunks
 * keep each call fast enough to live inside the serverless budget.
 */
const DEEP_BATCH = Math.max(
  4,
  Math.min(15, Number(process.env.SEER_GEMINI_DEEP_BATCH ?? "10") || 10),
);

/**
 * Cap Gemini calls per inbox load. With a 200-deep scan a cold cache
 * could mean 8 calls in seconds — enough to trip free-tier per-minute
 * limits. Overflow falls back to rules UNCACHED, so the next refresh
 * picks up where this one stopped and the whole inbox converges.
 */
const MAX_BATCHES_PER_LOAD = Math.max(
  1,
  Math.min(12, Number(process.env.SEER_GEMINI_MAX_BATCHES ?? "4") || 4),
);

/**
 * Hard TIME budget for Gemini within one load. The serverless function
 * dies at 60s — a slow model must never take the whole inbox load down
 * with it (the client would silently show its stale cache forever).
 */
const GEMINI_TIME_BUDGET_MS = Math.max(
  10_000,
  Math.min(45_000, Number(process.env.SEER_GEMINI_TIME_BUDGET_MS ?? "30000") || 30_000),
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
  // NOTE: finance-record-archive deliberately NOT here — anything
  // money-shaped gets the full AI read (an invoice that says "please
  // pay" must never be filed as a receipt off a 200-char snippet).
  "urgency-bait-delete",
  "shipper-status-delete",
  "autopay-record-archive",
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

/**
 * Quota cooldown, shared across serverless instances via KV: when Google
 * says "quota exceeded", every retry is a wasted request — stop calling
 * until the window resets instead of failing on each load.
 */
const COOLDOWN_KEY = "gemini-cooldown";
type Cooldown = { until: number; reason: string };

/**
 * Second quota pool: the Vercel AI Gateway ships monthly included
 * credits per team. When the direct Google key is rate-limited, batches
 * fail over to the gateway instead of degrading to rules.
 */
function gatewayAvailable(): boolean {
  return Boolean(
    process.env.AI_GATEWAY_API_KEY ||
      process.env.VERCEL_OIDC_TOKEN ||
      process.env.VERCEL,
  );
}

function gatewayModel(): { model: string; label: string } {
  // Free-tier gateway restricts the newest models; 2.5-flash is open.
  const id =
    process.env.SEER_GATEWAY_MODEL?.trim() || "google/gemini-2.5-flash";
  return { model: id, label: `gateway:${id}` };
}

function cooldownFromError(msg: string): Cooldown | null {
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
  // Reply drafts respect the same quota cooldown → gateway failover
  const cooldown = await kvGet<Cooldown>(COOLDOWN_KEY).catch(() => null);
  if (cooldown && cooldown.until > Date.now() && gatewayAvailable()) {
    return gatewayModel();
  }
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
const SYSTEM_PROMPT = `You are Seer, the user's email triage engine. Read the FULL text of every email, then judge it in four steps.

STEP 1 — WHO WROTE IT: person or machine?
person = a human wrote this to the user personally. The tier field is the personal database's view: inner (proven — they exchange mail, contacts, meetings), known (writes repeatedly), new (no history — YOU judge credibility from the words: a specific ask about a real project, company, or personal matter, mutual names, a reply to something the user did = credible; a template wearing a first name = not). Set sender and credible.
For person mail the question is WHAT ARE THEY ASKING — put it in task, verbatim-short ("send the signed LMA paperwork"). Action = respond (act_today if deadline-bound). A credible person is NEVER deleted.

STEP 2 — IMPORTANCE (score 0-3). Does this matter to the user's life or money?
3 = critical: money at risk, a real person waiting on them, a deadline with real consequences
2 = relevant: concrete information about their money, family, work, home, or health they would want to know
1 = marginal: legitimately their mail, but knowing it changes nothing (routine notices, completed events, records)
0 = noise: marketing, promos, engagement bait, anything blasted to thousands

STEP 3 — ACTIONABILITY: name the deed.
act = a specific thing only they can do — pay X, sign Y, reply to Z, deposit the check, RSVP. Name it in deed.
read = one-time information genuinely worth their eyes
file = a record they'd realistically SEARCH for later (receipt, confirmation number, statement, tax/legal)
none = no deed, no info worth their time. deed = "none" unless act.

STEP 4 — ACTION from the two axes:
- deed named → act_today (or respond when it's answering a person)
- importance 3 → never below read_and_archive; person waiting → respond
- importance 2: read → read_and_delete · file → read_and_archive
- importance 1: file → read_and_archive · otherwise read_and_delete or delete_now
- importance 0 → delete_now, or unsubscribe when it's a mailing list
- glance_promo is EXCEPTIONAL: only for a brand the user demonstrably buys from (their receipts show it) AND a deal they'd plausibly want. Default for promos is delete_now/unsubscribe — a promo is not worth a glance.
- needs_review: LAST RESORT (<5%), only when a wrong call could hurt a relationship or money.

HARD RULES (override everything above):
- Money at risk (payment failed/declined, fraud, past due, account locked) → act_today, any sender, any history.
- Money owed TO the user (refund/rebate/settlement check) → act_today "Deposit the check" — never expires.
- An unpaid bill (amount due, no autopay mention) → act_today "Pay the <biller> bill". A PAID invoice or autopay "bill ready" → file. A statement is a record; an unpaid bill is a task; an uncashed check is cash on the table.
- URGENCY DECAYS with age: expired check-ins, delivery windows, event reminders, verification codes are DEAD → delete_now. Bills and checks never decay.
- Fake urgency ("expires tonight!", "action required") from marketing = importance 0.
- Passive status updates (shipped/delivered/completed/liked) need nothing — the event happens whether they read it or not.
- Sender history never mutes risk: judge THIS message's intent first.

Input fields: id, from, email, subject, snippet (full text), and optional predictors: tier, age (days), rel, sent/recv, stale, contact, meeting, past (what they did with this sender's mail).
Priority when signals conflict: meeting > contact > engaged rel > past behavior > content.

OUTPUT one item per input id:
- importance: 0-3 as scored
- deed: the specific thing to do, or "none"
- task: for a deed → a 2-6 word imperative WITH its particulars ("Pay the $140 pool invoice", "Deposit the State Farm check"). For no-deed mail → the ONE specific fact worth knowing, written like a sharp lock-screen notification with names/amounts/dates from the body: "Hilary's groceries land June 27", "Ubiquiti login code — was it you?", "Play terms change Aug 28", "$89 Netflix renewal on the 1st". FORBIDDEN: restating the subject line, generic labels ("statement ready", "order update", "payment receipt"), and filler prefixes ("Be aware:", "FYI:", "Note:"). If you cannot state a specific fact worth the user's eyes, importance is 0 and the action is delete_now with task "none".
- category: 1-3 word life bucket in the user's terms (use their profile: Groceries, Travel, Kids & school, Golf, Money & bills, Payroll, Recruiting, Health, Home, Work, Receipts, Deliveries, Security). STALENESS in the name when the event passed: "Old trip", "Groceries — delivered". Same word every time.
- action, confidence, reason (short why), instruction (one sentence), sender, credible.`;

type CompactItem = {
  id: string;
  from: string;
  email: string;
  subject: string;
  snippet: string;
  /** Personal-database tier for the main filter */
  tier?: string;
  /** Days since the email arrived (omitted when fresh) */
  age?: number;
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
  /** Threads replied to from inside Seer (threadId → ISO time). */
  replied?: Record<string, string> | null;
  /** Audits: skip the local junk pre-filter so every email is AI-judged. */
  forceGemini?: boolean;
  /**
   * Deep read: fetch the FULL body text for a message about to be sent
   * to Gemini. Each email is read once (decision cached + labeled), so
   * the whole inbox costs pennies — snippets are only the fallback.
   */
  fetchBody?: (id: string) => Promise<string | null>;
};

/**
 * "It really has to read every word": 12k chars covers essentially any
 * human-written email whole (~3k tokens); machine blasts truncate fine.
 */
const DEEP_BODY_CHARS = 12_000;
/** Max time spent fetching bodies per load — degrade to snippets after. */
const BODY_FETCH_BUDGET_MS = 10_000;
const BODY_FETCH_CONCURRENCY = 8;

async function deepenChunk(
  chunk: GeminiTriageItem[],
  fetchBody: (id: string) => Promise<string | null>,
  deadline: number,
): Promise<GeminiTriageItem[]> {
  const out = [...chunk];
  for (let i = 0; i < out.length; i += BODY_FETCH_CONCURRENCY) {
    if (Date.now() > deadline) break;
    const wave = out.slice(i, i + BODY_FETCH_CONCURRENCY);
    const bodies = await Promise.allSettled(
      wave.map((m) => fetchBody(m.id)),
    );
    bodies.forEach((r, j) => {
      if (r.status === "fulfilled" && r.value && r.value.length > 50) {
        out[i + j] = {
          ...out[i + j],
          snippet: r.value.slice(0, DEEP_BODY_CHARS),
        };
      }
    });
  }
  return out;
}

function compactPayload(
  batch: GeminiTriageItem[],
  history: MailHistory | null | undefined,
  extras?: TriageExtras,
  tiers?: Map<string, string>,
): CompactItem[] {
  return batch.map((m) => {
    const sig = historySignals(history, m.fromEmail);
    const item: CompactItem = {
      id: m.id,
      from: (m.fromName || m.fromEmail).slice(0, 60),
      email: m.fromEmail,
      subject: m.subject.slice(0, 140),
      // Strip html-to-text residue (image alts, bare <url> refs) that
      // wastes tokens and poisons Gemini's instructions
      // Deep-read bodies arrive pre-sliced at DEEP_BODY_CHARS; plain
      // list snippets are ~200 chars — this cap protects tokens either way
      snippet: m.snippet
        .replace(/\[image:[^\]]*\]/gi, " ")
        .replace(/<https?:\/\/[^>\s]+>/g, " ")
        .replace(/\s+/g, " ")
        .slice(0, DEEP_BODY_CHARS),
    };
    const tier = tiers?.get(m.fromEmail.toLowerCase());
    if (tier) item.tier = tier;
    const age = ageInDays(m.receivedAt);
    if (age >= 2) item.age = age;
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
  via?: { model: LanguageModel | string; label: string },
  tiers?: Map<string, string>,
): Promise<Map<string, AssistantClassifyResult>> {
  const out = new Map<string, AssistantClassifyResult>();
  if (batch.length === 0) return out;

  const payload = compactPayload(batch, history, extras, tiers);
  const { model, label } = via ?? (await resolveModel());
  // Static prompt first (implicit-cache prefix), then the user's own
  // "about me" memory — identical bytes call to call until they edit it.
  const profileBlock = profilePromptBlock(extras?.profile);
  const system = profileBlock
    ? `${SYSTEM_PROMPT}\n\n${profileBlock}`
    : SYSTEM_PROMPT;
  const { output } = await generateText({
    model,
    temperature: 0,
    maxRetries: 0, // a retry against an exhausted quota is a wasted request
    // A hung upstream call must never eat the function's 60s budget —
    // that kills the whole inbox load and strands users on stale cache.
    abortSignal: AbortSignal.timeout(30_000),
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
      task:
        row.task && !/^(none|n\/a)$/i.test(row.task.trim())
          ? row.task.trim().slice(0, 80)
          : undefined,
      category: row.category?.trim().slice(0, 40) || undefined,
      senderKind: row.sender,
      credible: row.credible,
      importance: row.importance,
      deed: row.deed?.trim().slice(0, 100) || undefined,
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
    task: r.task,
    category: r.category,
    importance: r.importance,
    deed: r.deed,
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

  // THE PERSONAL DATABASE — resolve every sender's tier first.
  // Local evidence (sent history, contacts, meetings, shape) decides
  // most for free; genuinely unknown senders go to the AI's full read.
  const people: PeopleDb = await loadPeople(accountEmail).catch(() => ({}));
  const tiers = new Map<string, string>();
  let peopleDirty = false;
  for (const item of items) {
    const key = item.fromEmail.toLowerCase();
    if (tiers.has(key)) continue;
    const stored = people[key];
    if (stored) {
      tiers.set(key, stored.tier);
      continue;
    }
    const sig = historySignals(history, item.fromEmail);
    const ctx = contextSignals(extras?.personal, item.fromEmail);
    const evidence = tierFromEvidence({
      fromEmail: item.fromEmail,
      sentTo: sig.sentTo,
      receivedFrom: sig.receivedFrom,
      inContacts: ctx.inContacts,
      hasMeeting: Boolean(ctx.meeting),
    });
    if (evidence) {
      tiers.set(key, evidence.tier);
      people[key] = {
        email: key,
        name: item.fromName,
        tier: evidence.tier,
        reason: evidence.reason,
        by: "evidence",
        judgedAt: new Date().toISOString(),
      };
      peopleDirty = true;
    } else {
      tiers.set(key, "new"); // the AI judges credibility from the words
    }
  }

  // 0. Already replied — the strongest "handled" signal there is. If the
  // user's last reply on this thread is NEWER than this message, the ball
  // is in the other court; a follow-up that arrived after their reply
  // still triages normally.
  const repliedAt = (threadId?: string): string | null => {
    if (!threadId) return null;
    const fromSent = history?.repliedThreads?.[threadId];
    const fromApp = extras?.replied?.[threadId];
    if (fromSent && fromApp) return fromSent > fromApp ? fromSent : fromApp;
    return fromSent ?? fromApp ?? null;
  };

  // 1. Taught overrides + 2. learned priors from the user's own actions
  for (const item of items) {
    const answered = repliedAt(item.threadId);
    if (answered && item.receivedAt && answered > item.receivedAt) {
      results.set(item.id, {
        action: "read_and_archive",
        confidence: "HIGH",
        reason: "You already replied to this thread",
        debug: debugFor(item, history, "already-replied"),
        source: "rules",
        instruction: "Handled — you replied. Archive it.",
        task: "Be aware: you already replied",
      });
      continue;
    }

    // 0b. Calendar invites — the RSVP inside the email IS the action.
    // Answered (in Gmail, Calendar, or Seer) → the email is done;
    // unanswered → the card asks for exactly one tap.
    const invite = inviteSignals(extras?.personal, item.subject);
    if (invite) {
      if (invite.answered) {
        const verb =
          invite.event.myStatus === "declined"
            ? "declined"
            : invite.event.myStatus === "tentative"
              ? "responded maybe to"
              : "accepted";
        results.set(item.id, {
          action: "read_and_archive",
          confidence: "HIGH",
          reason: `You already ${verb} this invite — it's on your calendar`,
          debug: debugFor(item, history, "invite-answered"),
          source: "rules",
          instruction: "Handled — RSVP is on your calendar. Archive it.",
          task: "Be aware: RSVP is on your calendar",
        });
      } else {
        results.set(item.id, {
          action: "act_today",
          confidence: "HIGH",
          reason: "Calendar invite waiting on your RSVP",
          debug: debugFor(item, history, "invite-needs-rsvp"),
          source: "rules",
          instruction: "Accept, decline, or maybe — one tap in Seer.",
          task: "RSVP yes or no",
        });
      }
      continue;
    }

    // Organizer-side receipts ("Accepted: Standup") are pure noise
    if (RSVP_RECEIPT_SUBJECT.test(item.subject)) {
      results.set(item.id, {
        action: "read_and_delete",
        confidence: "HIGH",
        reason: "RSVP receipt — the response is already on the calendar",
        debug: debugFor(item, history, "rsvp-receipt-delete"),
        source: "rules",
        instruction: "Someone answered your invite. Nothing to do — delete.",
        task: "Be aware: they answered your invite",
      });
      continue;
    }

    // INTENT pierces sender history: a sender you taught/learned to
    // dismiss can still send the ONE message that needs you — the 347th
    // autopay email that says "autopay FAILED". Strict needs-you
    // signals (payment failed, fraud, signature required, security
    // alert, 2FA) bypass the mute and demand action.
    const DISMISSIVE = new Set<TriageAction>([
      "delete_now",
      "unsubscribe",
      "read_and_delete",
      "glance_promo",
      "read_and_archive",
    ]);
    const escape = needsYouEscape(item.subject, item.snippet);

    const override = await getOverride(item.fromEmail);
    if (override && !(DISMISSIVE.has(override) && escape)) {
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
    if (override && escape) {
      results.set(item.id, {
        action: "act_today",
        confidence: "HIGH",
        reason:
          "Muted sender, but THIS one needs you — payment/security/delivery language",
        debug: debugFor(item, history, "muted-sender-needs-you"),
        source: "rules",
        instruction:
          "You normally ignore this sender, but this message says something failed or needs action — open it.",
        task: "Open it — something failed",
      });
      continue;
    }

    const learned = learnedPrior(extras?.actionMemory, item.fromEmail);
    if (learned && escape) {
      results.set(item.id, {
        action: "act_today",
        confidence: "HIGH",
        reason:
          "You usually dismiss this sender, but THIS one has needs-you language",
        debug: debugFor(item, history, "muted-sender-needs-you"),
        source: "rules",
        instruction:
          "Break in pattern: something failed or needs action — open it.",
        task: "Open it — something failed",
      });
      continue;
    }
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
        task: hit.task,
        category: hit.category,
        importance: hit.importance,
        deed: hit.deed,
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
      // "Archive" from a robot that isn't a record (no receipt/reference
      // in sight) predates the delete-beats-archive philosophy — re-review.
      const suspiciousArchive =
        labeled === "read_and_archive" &&
        !ctx.inContacts &&
        !ctx.meeting &&
        rel !== "engaged" &&
        !RECORD_HINT.test(`${item.subject} ${item.snippet}`);
      if (!suspiciousUrgent && !suspiciousArchive) {
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
    if (!ctx.inContacts && !ctx.meeting && !extras?.forceGemini) {
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
    // Fresh load, fresh status — a stale error from an hour ago must
    // not paint "offline" over a load that worked fine.
    lastGeminiError = null;

    // Direct Google key first; if it's in quota cooldown, fail over to
    // the Vercel AI Gateway (separate monthly credit pool) before ever
    // degrading to rules.
    const cooldown = await kvGet<Cooldown>(COOLDOWN_KEY).catch(() => null);
    let useGateway = Boolean(
      cooldown && cooldown.until > Date.now() && gatewayAvailable(),
    );
    if (cooldown && cooldown.until > Date.now() && !useGateway) {
      const mins = Math.ceil((cooldown.until - Date.now()) / 60000);
      lastGeminiError = `${cooldown.reason} (~${mins}m). Decisions fall back to rules meanwhile.`;
    } else {
      const geminiStarted = Date.now();
      const bodyDeadline = geminiStarted + BODY_FETCH_BUDGET_MS;
      // Whole-email reads → smaller chunks, same email budget per load
      const step = extras?.fetchBody ? DEEP_BATCH : BATCH;
      const limit = Math.min(forGemini.length, MAX_BATCHES_PER_LOAD * BATCH);
      for (let i = 0; i < limit; i += step) {
        if (Date.now() - geminiStarted > GEMINI_TIME_BUDGET_MS) {
          lastGeminiError = `Time budget hit — ${limit - i} emails deferred to the next refresh`;
          break;
        }
        let chunk = forGemini.slice(i, i + step);
        // Read the WHOLE email, not the preview — once per message,
        // then the verdict is cached and labeled forever.
        if (extras?.fetchBody) {
          chunk = await deepenChunk(chunk, extras.fetchBody, bodyDeadline);
        }
        try {
          const mapped = await geminiBatch(
            chunk,
            history,
            extras,
            useGateway ? gatewayModel() : undefined,
            tiers,
          );
          for (const [id, r] of mapped) {
            results.set(id, r);
            toSave.set(id, toCached(r));
            // Grow the personal database: AI verdicts on unknown
            // senders are stored forever (outbound mail later promotes)
            const src = chunk.find((c) => c.id === id);
            const key = src?.fromEmail.toLowerCase();
            if (key && tiers.get(key) === "new" && r.senderKind) {
              const tier: PersonTier =
                r.senderKind === "person" && r.credible
                  ? "new-credible"
                  : "machine";
              people[key] = {
                email: key,
                name: src?.fromName,
                tier,
                reason: r.reason.slice(0, 120),
                by: "ai",
                judgedAt: new Date().toISOString(),
              };
              tiers.set(key, tier);
              peopleDirty = true;
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
          console.error(
            "[seer] Gemini triage failed:",
            useGateway ? "(gateway)" : "(direct)",
            msg,
          );
          const cd = cooldownFromError(msg);
          // Overloaded model / hung call — transient, not quota
          const transient =
            /high demand|overloaded|unavailable|503|timed? ?out|abort/i.test(
              msg,
            );
          if (cd && !useGateway) {
            // Direct key is out — remember it, then retry THIS chunk
            // through the gateway credit pool.
            await kvSet(COOLDOWN_KEY, cd).catch(() => {});
            if (gatewayAvailable()) {
              useGateway = true;
              i -= step;
              continue;
            }
            const mins = Math.ceil((cd.until - Date.now()) / 60000);
            lastGeminiError = `${cd.reason} (~${mins}m). Decisions fall back to rules meanwhile.`;
          } else if (transient && !useGateway && gatewayAvailable()) {
            // Google's model is busy — same batch, different pipe
            useGateway = true;
            i -= step;
            continue;
          }
          break;
        }
      }
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

  // Urgency decay pass — covers every source, including decisions that
  // were correct days ago but are saved in caches/labels as act_today.
  for (const item of items) {
    const r = results.get(item.id);
    if (r) results.set(item.id, applyUrgencyDecay(item, r, history));
  }

  // Person-protect: someone from your inner circle is never silently
  // trashed, whatever any layer decided. (Taught overrides still win —
  // teaching a sender delete IS an explicit decision about a person.)
  for (const item of items) {
    const r = results.get(item.id);
    if (!r || r.source === "override") continue;
    const tier = tiers.get(item.fromEmail.toLowerCase());
    if (
      tier === "inner" &&
      (r.action === "delete_now" || r.action === "unsubscribe")
    ) {
      results.set(item.id, {
        ...r,
        action: "read_and_archive",
        reason: "Inner circle — never auto-deleted",
        debug: { ...r.debug, ruleId: "person-protect" },
      });
    }
  }

  if (peopleDirty) await savePeople(accountEmail, people).catch(() => {});
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
