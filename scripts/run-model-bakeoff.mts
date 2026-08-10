/**
 * Bounded, paid model bake-off over 40 full real emails.
 *
 * Uses the complete Archive/Trash sample produced by audit-mail-actions.mts.
 * Models do NOT see the observed action. Scoring happens afterward against:
 *  - the user's actual Archive/Trash behavior; and
 *  - full-content audit corrections for historical actions that looked risky.
 *
 * Outputs exact AI SDK usage, Gateway generation IDs/cost metadata, latency,
 * decision agreement, false deletes, and missed disposables.
 */
import { promises as fs } from "node:fs";
import {
  generateText,
  Output,
} from "ai";
import {
  CHIEF_OF_STAFF_SYSTEM,
  conversationPayload,
} from "../src/lib/v2/intelligence/model.ts";
import {
  modelReadResultSchema,
  normalizeModelReadResult,
  type ReadResult,
} from "../src/lib/v2/intelligence/schema.ts";
import type {
  Conversation,
  Message,
} from "../src/lib/v2/providers/types.ts";

type SampleMessage = {
  index: number;
  action: "archive" | "trash";
  subject: string;
  from: string;
  to: string[];
  cc: string[];
  at: string;
  attachments: string[];
  body: string;
};

type ModelResult = {
  index: number;
  output?: ReadResult;
  error?: string;
  latencyMs: number;
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
    reasoningTokens?: number;
    cachedInputTokens?: number;
    totalTokens?: number;
  };
  generationId?: string;
  reportedCostUsd?: number;
  providerMetadata?: Record<string, unknown>;
};

type Expected = "retain" | "delete";

const MODELS = [
  "google/gemini-3.1-flash-lite",
  "anthropic/claude-sonnet-4.6",
  "openai/gpt-5.4",
] as const;

/**
 * Deliberately stratified: live work, records, relationship mail, completed
 * shells, OTPs, marketing, and risky historical actions.
 */
const SELECTED = [
  // Archive: 12 expected retain + 8 audit-identified likely noise.
  1, 4, 6, 9, 15, 20, 22, 31, 35, 41,
  45, 50, 53, 63, 65, 68, 74, 79, 82, 96,
  // Trash: 10 expected delete + 10 audit-identified risky deletes.
  101, 103, 105, 110, 112, 114, 118, 119, 123, 124,
  128, 131, 134, 136, 138, 140, 142, 146, 149, 150,
] as const;

/** Archived items the full-content audit judged likely disposable. */
const ARCHIVE_NOISE = new Set([4, 22, 35, 53, 63, 65, 79, 82]);
/** Trashed items the full-content audit judged risky and worth retaining. */
const RISKY_TRASH = new Set([
  114, 124, 128, 131, 134, 136, 138, 140, 149, 150,
]);

function expectedFor(message: SampleMessage): Expected {
  if (message.action === "archive") {
    return ARCHIVE_NOISE.has(message.index) ? "delete" : "retain";
  }
  return RISKY_TRASH.has(message.index) ? "retain" : "delete";
}

function parseAddress(value: string): { email: string; name?: string } {
  const match = value.match(/^(.*?)\s*<([^>]+)>$/);
  if (match) {
    return {
      name: match[1].trim() || undefined,
      email: match[2].trim().toLowerCase(),
    };
  }
  return { email: value.trim().toLowerCase() };
}

function toConversation(sample: SampleMessage): Conversation {
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

function gatewayMetadata(
  metadata: Record<string, unknown> | undefined,
): Record<string, unknown> {
  const gateway = metadata?.gateway;
  return gateway && typeof gateway === "object"
    ? (gateway as Record<string, unknown>)
    : {};
}

async function runOne(
  model: string,
  sample: SampleMessage,
): Promise<ModelResult> {
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
        conversation: conversationPayload(toConversation(sample)),
      }),
    });
    const metadata = result.providerMetadata as
      | Record<string, unknown>
      | undefined;
    const gateway = gatewayMetadata(metadata);
    const rawCost = gateway.cost;
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
        typeof gateway.generationId === "string"
          ? gateway.generationId
          : undefined,
      reportedCostUsd: Number.isFinite(cost) ? cost : undefined,
      providerMetadata: metadata,
    };
  } catch (error) {
    return {
      index: sample.index,
      error: error instanceof Error ? error.message : String(error),
      latencyMs: Date.now() - started,
    };
  }
}

function score(
  samples: SampleMessage[],
  results: ModelResult[],
) {
  const sampleByIndex = new Map(
    samples.map((sample) => [sample.index, sample]),
  );
  let correct = 0;
  let falseDeletes = 0;
  let missedDisposables = 0;
  let asksDetected = 0;
  let obligationsDetected = 0;
  let errors = 0;
  let latencyMs = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let reasoningTokens = 0;
  let totalTokens = 0;
  let reportedCostUsd = 0;

  const disagreements: {
    index: number;
    subject: string;
    expected: Expected;
    home: string;
    rationale: string;
  }[] = [];

  for (const result of results) {
    latencyMs += result.latencyMs;
    if (result.error || !result.output) {
      errors++;
      continue;
    }
    const sample = sampleByIndex.get(result.index);
    if (!sample) continue;
    const expected = expectedFor(sample);
    const retained = result.output.home !== "delete";
    const matches =
      (expected === "retain" && retained) ||
      (expected === "delete" && !retained);
    if (matches) correct++;
    else {
      if (expected === "retain") falseDeletes++;
      else missedDisposables++;
      disagreements.push({
        index: sample.index,
        subject: sample.subject,
        expected,
        home: result.output.home,
        rationale: result.output.rationale,
      });
    }
    if (
      result.output.ask &&
      !/^\s*nothing/i.test(result.output.ask)
    ) {
      asksDetected++;
    }
    if (result.output.obligation) obligationsDetected++;
    inputTokens += result.usage?.inputTokens ?? 0;
    outputTokens += result.usage?.outputTokens ?? 0;
    reasoningTokens += result.usage?.reasoningTokens ?? 0;
    totalTokens += result.usage?.totalTokens ?? 0;
    reportedCostUsd += result.reportedCostUsd ?? 0;
  }
  return {
    evaluated: results.length - errors,
    correct,
    accuracy:
      results.length - errors > 0
        ? correct / (results.length - errors)
        : 0,
    falseDeletes,
    missedDisposables,
    asksDetected,
    obligationsDetected,
    errors,
    averageLatencyMs: results.length
      ? Math.round(latencyMs / results.length)
      : 0,
    usage: {
      inputTokens,
      outputTokens,
      reasoningTokens,
      totalTokens,
      reportedCostUsd,
    },
    disagreements,
  };
}

async function main() {
  const value = (flag: string, fallback: string) => {
    const position = process.argv.indexOf(flag);
    return position >= 0 ? process.argv[position + 1] : fallback;
  };
  const samplePath = value(
    "--sample",
    "/tmp/mail-action-audit.sample.json",
  );
  const outputPath = value("--out", "/tmp/model-bakeoff.json");
  const raw = JSON.parse(await fs.readFile(samplePath, "utf8")) as {
    messages: SampleMessage[];
  };
  const byIndex = new Map(
    raw.messages.map((message) => [message.index, message]),
  );
  const samples = SELECTED.map((index) => byIndex.get(index)).filter(
    (message): message is SampleMessage => Boolean(message),
  );
  if (samples.length !== SELECTED.length) {
    throw new Error(
      `Expected ${SELECTED.length} samples, found ${samples.length}`,
    );
  }

  const payloadPath = value("--write-payload", "");
  if (payloadPath) {
    const selectedModels = value("--models", "")
      .split(",")
      .map((model) => model.trim())
      .filter(Boolean);
    await fs.writeFile(
      payloadPath,
      JSON.stringify({
        ...(selectedModels.length ? { models: selectedModels } : {}),
        samples: samples.map((sample) => ({
          index: sample.index,
          expected: expectedFor(sample),
          subject: sample.subject,
          from: sample.from,
          to: sample.to,
          cc: sample.cc,
          at: sample.at,
          attachments: sample.attachments,
          body: sample.body,
        })),
      }),
      "utf8",
    );
    console.log(`Payload written: ${payloadPath}`);
    return;
  }

  const report: Record<
    string,
    { results: ModelResult[]; score: ReturnType<typeof score> }
  > = {};

  for (const model of MODELS) {
    console.log(`\n${model}`);
    const results: ModelResult[] = [];
    // Bounded concurrency; enough to finish promptly without a spend spike.
    let cursor = 0;
    async function worker() {
      for (;;) {
        const position = cursor++;
        const sample = samples[position];
        if (!sample) return;
        const result = await runOne(model, sample);
        results.push(result);
        console.log(
          `  ${results.length}/${samples.length} #${sample.index}` +
            (result.error ? " ERROR" : ""),
        );
      }
    }
    await Promise.all(Array.from({ length: 4 }, worker));
    results.sort((a, b) => a.index - b.index);
    report[model] = { results, score: score(samples, results) };
  }

  await fs.writeFile(
    outputPath,
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        sampleSize: samples.length,
        expectedRetain: samples.filter(
          (sample) => expectedFor(sample) === "retain",
        ).length,
        expectedDelete: samples.filter(
          (sample) => expectedFor(sample) === "delete",
        ).length,
        models: report,
      },
      null,
      2,
    ),
    "utf8",
  );

  console.log("\n=== SCOREBOARD ===");
  for (const [model, value] of Object.entries(report)) {
    const s = value.score;
    console.log(
      `${model}: ${(s.accuracy * 100).toFixed(1)}% | ` +
        `false-deletes ${s.falseDeletes} | missed-disposables ${s.missedDisposables} | ` +
        `errors ${s.errors} | avg ${s.averageLatencyMs}ms | ` +
        `cost $${s.usage.reportedCostUsd.toFixed(4)}`,
    );
  }
  console.log(`Full report: ${outputPath}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});

