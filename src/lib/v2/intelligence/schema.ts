import { z } from "zod";
import type { Home, Owner } from "../db/types";

/**
 * The one decision the chief of staff produces per conversation, plus the
 * business meaning it extracted. Every product surface consumes this record and
 * nothing else — no snippet, sender tier, or provider label gets a second vote.
 */

export const homeSchema = z.enum(["matter", "record", "delete", "undecided"]);
export const ownerSchema = z.enum(["you", "team", "them", "nobody"]);

export const yieldSchema = z.object({
  kind: z.enum(["matter_connection", "worth_reading", "contact", "fact"]),
  /** For matter_connection: the matter this touches (title or id). */
  matterRef: z.string().optional(),
  headline: z.string(),
  detail: z.string().optional(),
  evidenceRef: z.string().optional(),
});
export type Yield = z.infer<typeof yieldSchema>;

export const evidenceSchema = z.object({
  ref: z.string(),
  provenance: z.enum(["explicit", "system", "calendar", "observed", "inference"]),
  detail: z.string().optional(),
});
export type Evidence = z.infer<typeof evidenceSchema>;

/** What the model returns for one conversation. */
export const readResultSchema = z.object({
  home: homeSchema,
  summary: z.string(),
  rationale: z.string(),
  owner: ownerSchema,
  ask: z.string().optional(),
  /**
   * True when a signature, approval, regulatory, legal, or payment step is
   * still outstanding for the user. Safety treats this as un-deletable.
   */
  obligation: z.boolean().default(false),
  /**
   * A date the email itself states (ISO, YYYY-MM-DD) by which something is due
   * or a window closes. Only when the body actually says it — never inferred.
   */
  dueDate: z.string().optional(),
  matterRef: z.string().optional(),
  yields: z.array(yieldSchema).default([]),
  evidence: z.array(evidenceSchema).default([]),
});
export type ReadResult = z.infer<typeof readResultSchema>;

/**
 * Cross-provider generation schema. OpenAI strict structured output requires
 * EVERY property to appear in `required`; optional values must be nullable.
 * Google/Anthropic accept this shape too. Normalize nulls back to our cleaner
 * application type after generation.
 */
const modelYieldSchema = z.object({
  kind: z.enum(["matter_connection", "worth_reading", "contact", "fact"]),
  matterRef: z.string().nullable(),
  headline: z.string(),
  detail: z.string().nullable(),
  evidenceRef: z.string().nullable(),
});

const modelEvidenceSchema = z.object({
  ref: z.string(),
  provenance: z.enum([
    "explicit",
    "system",
    "calendar",
    "observed",
    "inference",
  ]),
  detail: z.string().nullable(),
});

export const modelReadResultSchema = z.object({
  home: homeSchema,
  summary: z.string(),
  rationale: z.string(),
  owner: ownerSchema,
  ask: z.string().nullable(),
  obligation: z.boolean(),
  dueDate: z.string().nullable(),
  matterRef: z.string().nullable(),
  yields: z.array(modelYieldSchema),
  evidence: z.array(modelEvidenceSchema),
});

export function normalizeModelReadResult(
  raw: z.infer<typeof modelReadResultSchema>,
): ReadResult {
  return readResultSchema.parse({
    ...raw,
    ask: raw.ask ?? undefined,
    dueDate: raw.dueDate ?? undefined,
    matterRef: raw.matterRef ?? undefined,
    yields: raw.yields.map((item) => ({
      ...item,
      matterRef: item.matterRef ?? undefined,
      detail: item.detail ?? undefined,
      evidenceRef: item.evidenceRef ?? undefined,
    })),
    evidence: raw.evidence.map((item) => ({
      ...item,
      detail: item.detail ?? undefined,
    })),
  });
}

/** A decision as persisted and read back. */
export type ConversationDecision = {
  id: string;
  conversationId: string;
  home: Home;
  proposedHome: Home;
  summary: string;
  rationale: string;
  owner: Owner;
  ask?: string;
  matterId?: string;
  vetoReasons: string[];
  yields: Yield[];
  modelVersion: string;
  contextVersion: string;
  decidedAt: string;
};

/** Bump when the read prompt or schema changes; invalidates cached reads. */
export const MODEL_VERSION = "v2-read-2-router";
export const CONTEXT_VERSION = "v2-ctx-1";
