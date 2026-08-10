import { NextResponse } from "next/server";
import { generateText, Output } from "ai";
import {
  CHIEF_OF_STAFF_SYSTEM,
  conversationPayload,
} from "@/lib/v2/intelligence/model";
import {
  modelReadResultSchema,
  normalizeModelReadResult,
} from "@/lib/v2/intelligence/schema";
import type {
  Conversation,
  Message,
} from "@/lib/v2/providers/types";

export const maxDuration = 300;
export const dynamic = "force-dynamic";

const MODELS = [
  "google/gemini-3.1-flash-lite",
  "anthropic/claude-sonnet-4.6",
  "openai/gpt-5.4",
] as const;

type Sample = {
  index: number;
  expected: "retain" | "delete";
  subject: string;
  from: string;
  to: string[];
  cc: string[];
  at: string;
  attachments: string[];
  body: string;
};

function parseAddress(value: string): { email: string; name?: string } {
  const match = value.match(/^(.*?)\s*<([^>]+)>$/);
  return match
    ? {
        name: match[1].trim() || undefined,
        email: match[2].trim().toLowerCase(),
      }
    : { email: value.trim().toLowerCase() };
}

function conversationOf(sample: Sample): Conversation {
  const message: Message = {
    providerMessageId: `sample-${sample.index}`,
    from: parseAddress(sample.from),
    to: sample.to.map(parseAddress),
    cc: sample.cc.map(parseAddress),
    sentAt: sample.at,
    snippet: sample.body.slice(0, 240),
    bodyHtml: null,
    bodyText: sample.body,
    isUnread: false,
    isOutgoing: false,
    attachments: sample.attachments.map((filename, position) => ({
      id: `${sample.index}-${position}`,
      filename,
      mimeType: "",
      sizeBytes: 0,
    })),
  };
  return {
    providerConversationId: `sample-${sample.index}`,
    subject: sample.subject,
    messages: [message],
    lastMessageAt: sample.at,
  };
}

function gateway(
  metadata: Record<string, unknown> | undefined,
): Record<string, unknown> {
  const value = metadata?.gateway;
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : {};
}

async function callModel(model: (typeof MODELS)[number], sample: Sample) {
  const started = Date.now();
  try {
    const result = await generateText({
      model,
      temperature: 0,
      maxRetries: 0,
      abortSignal: AbortSignal.timeout(90_000),
      output: Output.object({ schema: modelReadResultSchema }),
      providerOptions: {
        gateway: { caching: "auto" },
        google: {
          thinkingConfig: {
            thinkingLevel: "minimal",
            includeThoughts: false,
          },
        },
        anthropic: {
          effort: "medium",
          thinking: { type: "adaptive" },
        },
        openai: {
          reasoningEffort: "medium",
          reasoningSummary: "concise",
        },
      },
      system: CHIEF_OF_STAFF_SYSTEM,
      prompt: JSON.stringify({
        context:
          "No business graph supplied for this bake-off. Judge only the complete email.",
        conversation: conversationPayload(conversationOf(sample)),
      }),
    });
    const metadata = result.providerMetadata as
      | Record<string, unknown>
      | undefined;
    const gatewayMeta = gateway(metadata);
    const rawCost = gatewayMeta.cost;
    const cost =
      typeof rawCost === "number"
        ? rawCost
        : typeof rawCost === "string"
          ? Number(rawCost)
          : undefined;
    return {
      index: sample.index,
      output: normalizeModelReadResult(result.output),
      latencyMs: Date.now() - started,
      usage: {
        inputTokens: result.usage.inputTokens,
        outputTokens: result.usage.outputTokens,
        reasoningTokens:
          result.usage.outputTokenDetails.reasoningTokens,
        cachedInputTokens:
          result.usage.inputTokenDetails.cacheReadTokens,
        totalTokens: result.usage.totalTokens,
      },
      generationId:
        typeof gatewayMeta.generationId === "string"
          ? gatewayMeta.generationId
          : undefined,
      costUsd: Number.isFinite(cost) ? cost : undefined,
    };
  } catch (error) {
    return {
      index: sample.index,
      error: error instanceof Error ? error.message : String(error),
      latencyMs: Date.now() - started,
    };
  }
}

function score(samples: Sample[], results: Awaited<ReturnType<typeof callModel>>[]) {
  const byIndex = new Map(samples.map((sample) => [sample.index, sample]));
  let correct = 0;
  let falseDeletes = 0;
  let missedDisposables = 0;
  let errors = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let reasoningTokens = 0;
  let costUsd = 0;
  let latencyMs = 0;
  const disagreements: Record<string, unknown>[] = [];
  for (const result of results) {
    latencyMs += result.latencyMs;
    if ("error" in result || !result.output) {
      errors++;
      continue;
    }
    const sample = byIndex.get(result.index);
    if (!sample) continue;
    const retained = result.output.home !== "delete";
    const matches =
      (sample.expected === "retain" && retained) ||
      (sample.expected === "delete" && !retained);
    if (matches) correct++;
    else {
      if (sample.expected === "retain") falseDeletes++;
      else missedDisposables++;
      disagreements.push({
        index: sample.index,
        subject: sample.subject,
        expected: sample.expected,
        home: result.output.home,
        rationale: result.output.rationale,
      });
    }
    inputTokens += result.usage.inputTokens ?? 0;
    outputTokens += result.usage.outputTokens ?? 0;
    reasoningTokens += result.usage.reasoningTokens ?? 0;
    costUsd += result.costUsd ?? 0;
  }
  const evaluated = results.length - errors;
  return {
    evaluated,
    correct,
    accuracy: evaluated ? correct / evaluated : 0,
    falseDeletes,
    missedDisposables,
    errors,
    averageLatencyMs: Math.round(latencyMs / results.length),
    usage: { inputTokens, outputTokens, reasoningTokens, costUsd },
    disagreements,
  };
}

/**
 * Preview-only, bounded evaluator. A one-time secret protects the request in
 * addition to Vercel Deployment Protection. It cannot run in production and
 * rejects samples over 40, preventing an accidental inbox-scale bill.
 */
export async function POST(request: Request) {
  if (process.env.VERCEL_ENV !== "preview") {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  const secret = process.env.BAKEOFF_SECRET;
  if (!secret || request.headers.get("x-bakeoff-secret") !== secret) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const body = (await request.json()) as {
    samples?: Sample[];
    models?: string[];
  };
  const samples = body.samples ?? [];
  if (samples.length === 0 || samples.length > 40) {
    return NextResponse.json(
      { error: "samples must contain 1..40 messages" },
      { status: 400 },
    );
  }
  const selectedModels = body.models?.length
    ? MODELS.filter((model) => body.models?.includes(model))
    : [...MODELS];
  if (selectedModels.length === 0) {
    return NextResponse.json(
      { error: "no supported models selected" },
      { status: 400 },
    );
  }

  const modelReports = await Promise.all(
    selectedModels.map(async (model) => {
      let cursor = 0;
      const results: Awaited<ReturnType<typeof callModel>>[] = [];
      async function worker() {
        for (;;) {
          const sample = samples[cursor++];
          if (!sample) return;
          results.push(await callModel(model, sample));
        }
      }
      await Promise.all(Array.from({ length: 4 }, worker));
      results.sort((a, b) => a.index - b.index);
      return [model, { score: score(samples, results), results }] as const;
    }),
  );

  return NextResponse.json({
    sampleSize: samples.length,
    models: Object.fromEntries(modelReports),
  });
}

