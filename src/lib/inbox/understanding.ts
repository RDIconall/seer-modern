import {
  getFallbackModel,
  getTriageModel,
  isModelBudgetError,
} from "@/lib/inbox/gemini-triage";
import { stripEmoji } from "@/lib/inbox/types";
import type { MailMessageListItem } from "@/lib/mail/types";
import { generateText, Output } from "ai";
import { z } from "zod";

/**
 * THE UNDERSTANDING RECORD — one deep read per email, cached forever.
 *
 * Every judgment Seer makes downstream (which matter, which org unit, does
 * it await your signature, how loud) comes from this record. Rules keep
 * only the work they're better at: exact codes, amounts, dates, headers.
 *
 * Bump UNDERSTANDING_VERSION when the schema or prompt changes; records
 * from older versions are re-read.
 */

export const UNDERSTANDING_VERSION = 3;

/**
 * What an email is FOR — the deep read's own verdict on disposal, which
 * is what Atlas partitions on (matter / record / fyi / disposable). This
 * is the "one brain" principle: the full-body read decides an email's
 * fate, not a snippet grader or a sender-shape rule.
 */
export type Disposition = "matter" | "record" | "fyi" | "disposable";

/** Bodies are trimmed here — beyond this, signature blocks and quoted
 * history dominate and add tokens without adding meaning. */
const BODY_CHARS = 8_000;

export type SignatureAsk = {
  /** "UC Davis Mutual CDA" — the document itself, not the subject line */
  document: string;
  counterparty?: string;
  /** "Adobe Sign" | "DocuSign" | "SignNow" | "email attachment" */
  platform?: string;
};

export type Understanding = {
  id: string;
  threadId: string;
  version: number;
  readAt: string;
  /** "signature request" | "invoice" | "study update" | "newsletter" … */
  kind: string;
  /** What this is, in one line, in the user's own vocabulary */
  oneLine: string;
  /** What is wanted, or "nothing — informational" */
  ask: string;
  owner: "you" | "team" | "them" | "nobody";
  /** Evidence ids the context compiler fed this read (person:/matter:/crm:/calendar:) */
  contextRefs?: string[];
  /** ISO date, only when the email actually states one */
  deadline?: string;
  /** Extracted deterministically from the body, never model-authored */
  amounts?: number[];
  entities: string[];
  /** Present ⇒ a document is waiting for the user's signature */
  signature?: SignatureAsk;
  /** The model's org call, validated against the user's registry */
  org: { unit: string; confidence: number };
  importance: number;
  /** What this email is FOR — the disposal verdict Atlas partitions on */
  disposition: Disposition;
  /**
   * ISO date when this email's relevance dies on its own (a delivery
   * window, an event date, a check-in, a code). Only set when the body
   * states or clearly implies one — this is how urgency expires without
   * keyword regexes.
   */
  expires?: string;
};

export type UnderstandingMap = Record<string, Understanding>;

const recordSchema = z.object({
  id: z.string(),
  kind: z
    .string()
    .describe(
      'what this email IS, 1-4 words: "signature request", "invoice", "study update", "IRB query", "shipping notice", "newsletter", "recruiting spam", "personal note"',
    ),
  oneLine: z
    .string()
    .describe(
      "one line of what this actually says, concrete and specific — names, documents, amounts. Never restate the subject.",
    ),
  ask: z
    .string()
    .describe(
      'what is being asked, imperative, or exactly "nothing — informational"',
    ),
  owner: z.enum(["you", "team", "them", "nobody"]),
  deadline: z
    .string()
    .optional()
    .describe("ISO date (YYYY-MM-DD) ONLY if the email states a real date"),
  entities: z
    .array(z.string())
    .describe("companies and people named in the email, max 6"),
  awaitsSignature: z
    .boolean()
    .describe(
      "true ONLY when a document is waiting for THIS USER to sign it (an e-sign invitation addressed to them, or an attached agreement they must execute). False for copies, completed notifications, and other people's signatures.",
    ),
  signatureDocument: z
    .string()
    .optional()
    .describe(
      'the document awaiting signature, named as a person would say it: "UC Davis Mutual CDA", "RDI_SOW-010 Trademarking Support"',
    ),
  signatureCounterparty: z.string().optional(),
  signaturePlatform: z
    .string()
    .optional()
    .describe('"Adobe Sign", "DocuSign", "SignNow", or "email attachment"'),
  orgUnit: z
    .string()
    .describe(
      "the function from the payload's functions list this belongs to, verbatim",
    ),
  orgConfidence: z.number().min(0).max(1),
  importance: z
    .number()
    .min(0)
    .max(3)
    .describe(
      "3 = costs money or a relationship today; 2 = real work owed; 1 = worth knowing; 0 = disposable",
    ),
  disposition: z
    .enum(["matter", "record", "fyi", "disposable"])
    .describe(
      'what this email is FOR. Most of a real inbox is fyi/disposable — be decisive: "matter" = a live concern with a counterparty that needs tracking (a real ask of the user, a negotiation, a decision, a signature, anyone waiting on them); "record" = no live story but worth finding later (receipt, executed contract, invoice, statement, confirmation number); "fyi" = one glance then gone (status update, notification, digest, newsletter with one useful fact); "disposable" = never needed their eyes (marketing, promotions, inert policy/ToS notices, automated noise, social/network notifications). A message is NOT a matter merely because it is work-related or from a real company.',
    ),
  expires: z
    .string()
    .optional()
    .describe(
      "ISO date (YYYY-MM-DD) when this email's relevance dies on its own — a delivery/check-in window, an event date, a verification code. Only set when the body states or clearly implies one; leave out for anything durable (bills, contracts, records).",
    ),
});

const batchSchema = z.object({ records: z.array(recordSchema) });

const SYSTEM = `You read a CEO's email and record what it MEANS. One record per email. You are the only thing standing between this person and a mountain of mail, so be concrete: name the document, the company, the number, the date.

Some emails carry a CONTEXT block — evidence the assistant already knows about the sender and the work this email belongs to. USE IT:
- Facts marked [explicit] (the user said so) and [system] (a CRM record) OUTRANK your own reading. A [explicit] VIP or board member is never disposable; a [system] open opportunity means the money is real.
- [calendar] and [observed] facts are true measurements — a recent shared meeting, how fast the user replies, what they usually do with this sender.
- [inference] is a scored hint (e.g. the matter this email likely continues) — weigh it, don't obey it.
- NO context block, or "no prior relationship on record", is itself evidence: an unknown sender with no history, no CRM record and no calendar tie is more likely fyi/disposable — unless the body itself carries a real ask, a signature, or an approval/regulatory/legal deadline, which always wins.
Never repeat the context block back; use it to judge owner, importance, and disposition.

Rules:
- oneLine: what the email actually says, not a restatement of the subject. "Bilal sent the UC Davis mutual CDA for your signature via Adobe Sign" — not "Signature request".
- ask: the specific thing wanted from the user, imperative ("Sign the UC Davis mutual CDA"), or exactly "nothing — informational" when nothing is owed.
- owner: "you" only when this person must personally act. "team" when a named colleague owns it. "them" when the ball is in the counterparty's court. "nobody" for pure notices.
- awaitsSignature: true ONLY when a document is waiting for THIS USER to execute — an e-sign invitation addressed to them, or an attached agreement they must sign. A "completed"/"signed by all parties" notice is NOT awaiting signature. Someone else's signature request forwarded for information is NOT.
- orgUnit: MUST be one entry from the payload's functions list, verbatim. Judge by what the email IS ABOUT and which direction money flows, never by the sender's domain:
  · A signature platform (Adobe Sign, DocuSign) is only the DELIVERY MECHANISM. File by the document: a customer CDA is sales — contracting; a state dissolution form or an acquisition approval is finance (ar/ap) or the board; a vendor's software agreement is systems (it).
  · Internal corporate paperwork (entity dissolution, registrations, acquisitions, tax, insurance) is NOT customer contracting.
  · Awarded, running work with a study code is operations — studies. Pricing or feasibility requests are sales — new requests. Payment chases are finance (ar/ap).
- orgConfidence: be honest. Below 0.6 means you truly could not tell.
- importance: what happens if this is ignored for a week.
- disposition: the single most important field — it decides where this email lives. Judge it from the MEANING, never the sender's shape (a no-reply address can carry an approval request; a person can send pure noise). BE DECISIVE: in a real executive inbox most mail is fyi or disposable, a minority are records, and only a genuine live concern is a matter. Marking everything a matter is the same as marking nothing.
  · matter = a LIVE concern with a counterparty that must be tracked: a real ask of the user, a negotiation, a decision they owe, a signature, an approval/regulatory/legal deadline, or someone waiting on their reply. Being work-related is NOT enough — there must be something unresolved.
  · record = no live story, but findable later: a receipt, an executed contract, an invoice, a statement, a confirmation number.
  · fyi = one glance then gone: status updates, notifications, reports, newsletters carrying a single useful fact, "we shipped it", "here's the weekly".
  · disposable = never needed their eyes: marketing, promotions, event invitations from vendors, inert policy/ToS updates, automated noise, social-network notifications (LinkedIn messages/connections), recruiting spam.
  Hard floor: an email with a real ask of the user, an awaiting signature, or an approval/regulatory/government deadline is ALWAYS a matter, whatever it looks like. Everything else earns "matter" only by being genuinely unresolved.
- expires: set the ISO date only when relevance genuinely dies on its own (a delivery/check-in window, an event, a code). Bills, invoices, contracts, and records never expire.
- Never invent a fact, a date, or a document name. If the body doesn't say it, leave it out.`;

/** Amounts belong to a regex, not a model — models paraphrase numbers. */
const AMOUNT = /\$\s?([\d,]+(?:\.\d{2})?)/g;

function extractAmounts(text: string): number[] {
  const out: number[] = [];
  for (const m of text.matchAll(AMOUNT)) {
    const n = Number(m[1].replace(/,/g, ""));
    if (Number.isFinite(n) && n > 0) out.push(n);
  }
  return [...new Set(out)].sort((a, b) => b - a).slice(0, 6);
}

export type ReadInput = Pick<
  MailMessageListItem,
  "id" | "threadId" | "fromEmail" | "fromName" | "subject" | "snippet"
> & { body?: string };

/** How many emails share one model call. Bodies are big; keep it modest. */
const PER_CALL = 6;

export type ReadOptions = {
  functions: string[];
  fetchBody: (id: string) => Promise<string | null>;
  /** Stop starting new calls past this deadline (cron ticks are bounded) */
  deadlineMs?: number;
  /** Parallel model calls */
  concurrency?: number;
  onProgress?: (done: number) => void;
  /**
   * The compiled context packet per message id — sender relationship,
   * calendar, likely matter, CRM facts, behavior. Fed into the read so
   * the model judges each email AS this user, with provenance.
   */
  contextById?: Map<string, { text: string; refs: string[] }>;
};

/**
 * Read a set of emails deeply. Returns only the records it managed to
 * produce — the caller merges them into the store, so a partial pass is
 * progress rather than failure.
 */
export async function readEmails(
  items: ReadInput[],
  opts: ReadOptions,
): Promise<Understanding[]> {
  if (items.length === 0) return [];
  const { model } = await getTriageModel();
  const fallback = getFallbackModel();
  const deadline = opts.deadlineMs ?? Date.now() + 120_000;
  const concurrency = opts.concurrency ?? 3;
  // Once the direct key is out of credits every call fails the same way;
  // flip to the gateway pool for the rest of this pass after the first hit.
  let useFallback = false;

  const batches: ReadInput[][] = [];
  for (let i = 0; i < items.length; i += PER_CALL) {
    batches.push(items.slice(i, i + PER_CALL));
  }

  const out: Understanding[] = [];
  let cursor = 0;

  async function worker() {
    for (;;) {
      const n = cursor++;
      const batch = batches[n];
      if (!batch || Date.now() > deadline) return;

      const bodies = await Promise.all(
        batch.map(async (m) => {
          if (m.body) return m.body;
          try {
            return (await opts.fetchBody(m.id)) ?? m.snippet;
          } catch {
            return m.snippet;
          }
        }),
      );

      const payload = {
        functions: opts.functions,
        emails: batch.map((m, k) => {
          const ctx = opts.contextById?.get(m.id);
          return {
            id: m.id,
            from: stripEmoji(m.fromName || m.fromEmail),
            fromEmail: m.fromEmail,
            subject: stripEmoji(m.subject),
            body: stripEmoji(bodies[k] ?? "").slice(0, BODY_CHARS),
            ...(ctx?.text ? { context: ctx.text } : {}),
          };
        }),
      };

      try {
        const runRead = (m: typeof model) =>
          generateText({
            model: m,
            temperature: 0,
            maxRetries: 1,
            abortSignal: AbortSignal.timeout(
              Math.max(15_000, Math.min(90_000, deadline - Date.now())),
            ),
            output: Output.object({ schema: batchSchema }),
            system: SYSTEM,
            prompt: JSON.stringify(payload),
          });

        let output;
        try {
          output = (await runRead(useFallback && fallback ? fallback.model : model))
            .output;
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          if (fallback && !useFallback && isModelBudgetError(msg)) {
            useFallback = true; // direct key is dead — switch the whole pass
            output = (await runRead(fallback.model)).output;
          } else {
            throw err;
          }
        }

        const byId = new Map(batch.map((m) => [m.id, m]));
        for (const r of output.records) {
          const src = byId.get(r.id);
          if (!src) continue;
          const bodyText =
            bodies[batch.indexOf(src)] ?? `${src.subject} ${src.snippet}`;
          out.push({
            id: r.id,
            threadId: src.threadId,
            version: UNDERSTANDING_VERSION,
            readAt: new Date().toISOString(),
            kind: stripEmoji(r.kind).slice(0, 40),
            oneLine: stripEmoji(r.oneLine).slice(0, 200),
            ask: stripEmoji(r.ask).slice(0, 160),
            owner: r.owner,
            ...(r.deadline && /^\d{4}-\d{2}-\d{2}/.test(r.deadline)
              ? { deadline: r.deadline.slice(0, 10) }
              : {}),
            ...(() => {
              const amounts = extractAmounts(
                `${src.subject}\n${bodyText.slice(0, BODY_CHARS)}`,
              );
              return amounts.length ? { amounts } : {};
            })(),
            entities: r.entities.slice(0, 6).map((e) => stripEmoji(e).slice(0, 60)),
            ...(r.awaitsSignature && r.signatureDocument
              ? {
                  signature: {
                    document: stripEmoji(r.signatureDocument).slice(0, 90),
                    ...(r.signatureCounterparty
                      ? {
                          counterparty: stripEmoji(
                            r.signatureCounterparty,
                          ).slice(0, 60),
                        }
                      : {}),
                    ...(r.signaturePlatform
                      ? {
                          platform: stripEmoji(r.signaturePlatform).slice(
                            0,
                            30,
                          ),
                        }
                      : {}),
                  },
                }
              : {}),
            org: {
              unit: r.orgUnit,
              confidence: r.orgConfidence,
            },
            importance: r.importance,
            ...(() => {
              const refs = opts.contextById?.get(r.id)?.refs;
              return refs && refs.length ? { contextRefs: refs } : {};
            })(),
            disposition: r.disposition,
            ...(r.expires && /^\d{4}-\d{2}-\d{2}/.test(r.expires)
              ? { expires: r.expires.slice(0, 10) }
              : {}),
          });
        }
        opts.onProgress?.(out.length);
      } catch (e) {
        console.error(
          `[seer] deep read batch ${n + 1}/${batches.length} failed:`,
          e instanceof Error ? e.message : e,
        );
      }
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(concurrency, batches.length) }, worker),
  );
  return out;
}
