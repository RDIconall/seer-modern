/**
 * Compact Atlas labels are a projection of a matter, not a replacement for
 * its durable title. The model sees the active board together so labels are
 * distinct; validation and fallbacks remain deterministic and cheap.
 */

import { generateText, Output } from "ai";
import { z } from "zod";

export const SHORT_TITLE_VERSION = 1;

const GENERIC_WORDS = new Set([
  "call",
  "catchup",
  "catch-up",
  "engagement",
  "follow",
  "follow-up",
  "intro",
  "introduction",
  "outreach",
]);

const STOP_WORDS = new Set([
  "a",
  "an",
  "and",
  "for",
  "from",
  "of",
  "on",
  "the",
  "to",
  "with",
]);

export type MatterNamingInput = {
  id: string;
  title: string;
  shortTitle: string | null;
  shortTitleSource: "inferred" | "user" | null;
  shortTitleVersion: number | null;
  counterparty: string | null;
  section: string | null;
  conversations: { subject: string; summary: string }[];
};

export type MatterNamingResult = {
  id: string;
  shortTitle: string;
  shortTitleSource: "inferred" | "user";
  shortTitleVersion: number;
};

export type MatterNamingCaller = (
  matters: MatterNamingInput[],
) => Promise<{ id: string; shortTitle: string }[]>;

function words(value: string): string[] {
  return value
    .replace(/[“”"'`]/g, "")
    .split(/[^a-zA-Z0-9]+/)
    .map((word) => word.trim())
    .filter(Boolean);
}

function displayWords(value: string): string[] {
  return words(value).filter((word) => !STOP_WORDS.has(word.toLowerCase()));
}

function titleCase(value: string): string {
  return value
    .split(/\s+/)
    .map((word) => (word ? word[0].toUpperCase() + word.slice(1) : word))
    .join(" ");
}

/**
 * Validate only observable naming constraints. The prompt supplies the
 * semantic no-user-name rule; this function makes model output safe to render.
 */
export function isValidShortTitle(value: string): boolean {
  const clean = value.trim().replace(/\s+/g, " ");
  const titleWords = words(clean);
  if (clean.length === 0 || clean.length > 50) return false;
  if (titleWords.length < 2 || titleWords.length > 6) return false;
  const lower = titleWords.map((word) => word.toLowerCase());
  if (lower.every((word) => GENERIC_WORDS.has(word))) return false;
  if (
    titleWords.length <= 2 &&
    lower.some((word) => GENERIC_WORDS.has(word))
  ) {
    return false;
  }
  return true;
}

type CompactMatterInput = Pick<MatterNamingInput, "title" | "counterparty"> & {
  subject?: string;
  conversations?: MatterNamingInput["conversations"];
};

function fallbackParts(input: CompactMatterInput): string[] {
  const subject = input.subject ?? input.conversations?.[0]?.subject ?? "";
  const source = [input.counterparty ?? "", subject, input.title].join(" ");
  const result: string[] = [];
  for (const word of displayWords(source)) {
    if (GENERIC_WORDS.has(word.toLowerCase())) continue;
    if (result.some((existing) => existing.toLowerCase() === word.toLowerCase())) {
      continue;
    }
    result.push(word);
    if (result.length === 6) break;
  }
  return result;
}

export function compactMatterTitle(
  input: CompactMatterInput,
): string {
  const parts = fallbackParts(input);
  if (parts.length < 2) {
    const titleParts = displayWords(input.title);
    for (const word of titleParts) {
      if (!parts.some((existing) => existing.toLowerCase() === word.toLowerCase())) {
        parts.push(word);
      }
      if (parts.length >= 2) break;
    }
  }
  const compact = titleCase(parts.slice(0, 6).join(" ")).slice(0, 50).trim();
  return isValidShortTitle(compact) ? compact : "Matter work";
}

function uniqueTitle(
  candidate: string,
  input: MatterNamingInput,
  used: Set<string>,
): string {
  const choices = [candidate, compactMatterTitle(input)];
  const subjectWords = displayWords(
    input.conversations[0]?.subject ?? "",
  );
  for (const word of subjectWords) {
    choices.push(`${candidate} ${word}`);
  }
  for (const choice of choices) {
    const clean = choice.replace(/\s+/g, " ").trim().slice(0, 50);
    const key = clean.toLowerCase();
    if (isValidShortTitle(clean) && !used.has(key)) return clean;
  }
  let ordinal = 2;
  const base = compactMatterTitle(input);
  while (used.has(`${base.toLowerCase()} ${ordinal}`)) ordinal++;
  return `${base} ${ordinal}`.slice(0, 50);
}

const namingSchema = z.object({
  matters: z.array(z.object({ id: z.string(), shortTitle: z.string() })),
});

const NAMING_SYSTEM = `Name the active work board.

Return one short title for each matter: 2-6 useful words, no more than 50
characters. Name THE WORK, not the fact that people are engaging. Include the
counterparty and the specific deliverable, decision, study, product, bid, or
process when useful. Never use the user's name, the user's company, or generic
phrases such as engagement, call, catch-up, follow-up, intro, or outreach alone.
Titles must be distinct across the full board. Do not copy a long subject line
verbatim. Return every supplied id exactly once.`;

export function createMatterNamingCaller(
  model = process.env.SEER_ROUTER_FAST_MODEL ?? "google/gemini-3.1-flash-lite",
): MatterNamingCaller {
  return async (matters) => {
    if (matters.length === 0) return [];
    const result = await generateText({
      model,
      temperature: 0,
      maxRetries: 0,
      abortSignal: AbortSignal.timeout(60_000),
      output: Output.object({ schema: namingSchema }),
      providerOptions: {
        gateway: { caching: "auto", sort: "cost" },
        google: {
          thinkingConfig: { thinkingLevel: "minimal", includeThoughts: false },
        },
      },
      system: NAMING_SYSTEM,
      prompt: JSON.stringify({ matters }),
    });
    return result.output.matters;
  };
}

const DEFAULT_CALLER = createMatterNamingCaller();

export async function nameMatterBatch(
  inputs: MatterNamingInput[],
  caller: MatterNamingCaller = DEFAULT_CALLER,
): Promise<MatterNamingResult[]> {
  const used = new Set<string>();
  for (const input of inputs) {
    if (input.shortTitleSource === "user" && input.shortTitle) {
      used.add(input.shortTitle.trim().toLowerCase());
    }
  }
  const needsNaming = inputs.filter(
    (input) =>
      input.shortTitleSource !== "user" &&
      (!input.shortTitle ||
        input.shortTitleVersion !== SHORT_TITLE_VERSION ||
        !isValidShortTitle(input.shortTitle)),
  );
  const proposed = await caller(needsNaming.length > 0 ? inputs : []);
  const proposals = new Map<string, string>();
  for (const item of proposed) {
    if (!proposals.has(item.id)) proposals.set(item.id, item.shortTitle);
  }

  return inputs.map((input) => {
    if (input.shortTitleSource === "user" && input.shortTitle) {
      return {
        id: input.id,
        shortTitle: input.shortTitle,
        shortTitleSource: "user",
        shortTitleVersion: input.shortTitleVersion ?? SHORT_TITLE_VERSION,
      };
    }
    const candidate = proposals.get(input.id);
    const shortTitle = uniqueTitle(
      candidate && isValidShortTitle(candidate)
        ? candidate.trim().replace(/\s+/g, " ")
        : compactMatterTitle(input),
      input,
      used,
    );
    used.add(shortTitle.toLowerCase());
    return {
      id: input.id,
      shortTitle,
      shortTitleSource: "inferred",
      shortTitleVersion: SHORT_TITLE_VERSION,
    };
  });
}
