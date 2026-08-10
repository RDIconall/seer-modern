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
  matterRef: z.string().optional(),
  yields: z.array(yieldSchema).default([]),
  evidence: z.array(evidenceSchema).default([]),
});
export type ReadResult = z.infer<typeof readResultSchema>;

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
export const MODEL_VERSION = "v2-read-1";
export const CONTEXT_VERSION = "v2-ctx-1";
