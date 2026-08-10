/**
 * Read-only behavioral audit over real Outlook Archive and Deleted Items.
 *
 * Fetches full message bodies, sender name/address, To/CC, dates, and
 * attachment names. Gemini infers why each message was kept or deleted and
 * returns behavior patterns Seer can learn. Captures usageMetadata on every
 * call so this run's token cost is measurable.
 *
 * Usage (secrets via environment, never arguments):
 *   GOOGLE_GENERATIVE_AI_API_KEY=... \
 *   vercel env run -e production -- \
 *   tsx scripts/audit-mail-actions.mts --account you@example.com \
 *     --archive 100 --trash 50 --out /tmp/mail-action-audit.json
 */
import { promises as fs } from "node:fs";
import kv from "../src/lib/store/kv.ts";
import { htmlToText } from "../src/lib/v2/intelligence/html-text.ts";
import type { StoredAccount } from "../src/lib/store/accounts.ts";

type Recipient = { emailAddress?: { address?: string; name?: string } };
type GraphAttachment = {
  id?: string;
  name?: string;
  contentType?: string;
  size?: number;
};
type GraphMessage = {
  id: string;
  conversationId?: string;
  subject?: string;
  from?: Recipient;
  toRecipients?: Recipient[];
  ccRecipients?: Recipient[];
  receivedDateTime?: string;
  sentDateTime?: string;
  bodyPreview?: string;
  body?: { contentType?: string; content?: string };
  attachments?: GraphAttachment[];
};

type FolderAction = "archive" | "trash";
type AuditMessage = {
  index: number;
  action: FolderAction;
  subject: string;
  from: string;
  to: string[];
  cc: string[];
  at: string;
  attachments: string[];
  body: string;
};

type MessageAnalysis = {
  index: number;
  likelyReason: string;
  category: string;
  signals: string[];
  anomaly: string;
  confidence: number;
};

type BatchResult = {
  analyses: MessageAnalysis[];
  patternNotes: string[];
};

type Usage = {
  requests: number;
  promptTokens: number;
  outputTokens: number;
  thinkingTokens: number;
  totalTokens: number;
  cachedTokens: number;
  modelVersions: Record<string, number>;
};

const { kvGet } = kv as unknown as {
  kvGet: <T>(key: string) => Promise<T | null>;
};

function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : fallback;
}

function address(recipient: Recipient | undefined): string {
  const email = recipient?.emailAddress?.address ?? "";
  const name = recipient?.emailAddress?.name;
  return name && name !== email ? `${name} <${email}>` : email;
}

function recipientList(items: Recipient[] | undefined): string[] {
  return (items ?? []).map(address).filter(Boolean);
}

function readableMessageBody(message: GraphMessage): string {
  const content = message.body?.content ?? "";
  if ((message.body?.contentType ?? "").toLowerCase() === "html") {
    return htmlToText(content) || message.bodyPreview || "";
  }
  return content.trim() || message.bodyPreview || "";
}

async function refreshMicrosoft(
  account: StoredAccount,
): Promise<string> {
  if (
    account.accessToken &&
    (!account.expiresAt || account.expiresAt > Date.now() + 60_000)
  ) {
    return account.accessToken;
  }
  if (!account.refreshToken) throw new Error("Outlook refresh token is missing");
  const issuer = process.env.AUTH_MICROSOFT_ENTRA_ID_ISSUER;
  const tenant = issuer
    ? new URL(issuer).pathname.split("/")[1]
    : "common";
  const response = await fetch(
    `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`,
    {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: process.env.AUTH_MICROSOFT_ENTRA_ID_ID ?? "",
        client_secret: process.env.AUTH_MICROSOFT_ENTRA_ID_SECRET ?? "",
        grant_type: "refresh_token",
        refresh_token: account.refreshToken,
      }),
    },
  );
  if (!response.ok) {
    throw new Error(
      `Microsoft refresh failed: ${response.status} ${(await response.text()).slice(0, 180)}`,
    );
  }
  const json = (await response.json()) as { access_token: string };
  return json.access_token;
}

async function graphGet<T>(token: string, url: string): Promise<T> {
  for (let attempt = 0; attempt < 4; attempt++) {
    const response = await fetch(url, {
      headers: { authorization: `Bearer ${token}` },
    });
    if (response.ok) return (await response.json()) as T;
    if ((response.status === 429 || response.status >= 500) && attempt < 3) {
      await new Promise((resolve) =>
        setTimeout(resolve, 1000 * 2 ** attempt),
      );
      continue;
    }
    throw new Error(`Graph ${response.status}: ${(await response.text()).slice(0, 180)}`);
  }
  throw new Error("Graph request failed");
}

async function listFolder(
  token: string,
  folder: "archive" | "deleteditems",
  limit: number,
  action: FolderAction,
): Promise<AuditMessage[]> {
  const out: AuditMessage[] = [];
  const select =
    "id,conversationId,subject,from,toRecipients,ccRecipients,receivedDateTime,sentDateTime,bodyPreview,body,hasAttachments";
  let next: string | null =
    `https://graph.microsoft.com/v1.0/me/mailFolders/${folder}/messages` +
    `?$top=${Math.min(100, limit)}&$orderby=receivedDateTime desc` +
    `&$select=${select}` +
    "&$expand=attachments($select=id,name,contentType,size)";

  while (next && out.length < limit) {
    const page: {
      value?: GraphMessage[];
      "@odata.nextLink"?: string;
    } = await graphGet(token, next);
    for (const message of page.value ?? []) {
      if (out.length >= limit) break;
      out.push({
        index: 0,
        action,
        subject: message.subject ?? "(no subject)",
        from: address(message.from),
        to: recipientList(message.toRecipients),
        cc: recipientList(message.ccRecipients),
        at:
          message.receivedDateTime ??
          message.sentDateTime ??
          "",
        attachments: (message.attachments ?? [])
          .map((attachment) => attachment.name ?? "")
          .filter(Boolean),
        body: readableMessageBody(message),
      });
    }
    next = page["@odata.nextLink"] ?? null;
  }
  return out;
}

const RESPONSE_SCHEMA = {
  type: "OBJECT",
  required: ["analyses", "patternNotes"],
  properties: {
    analyses: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        required: [
          "index",
          "likelyReason",
          "category",
          "signals",
          "anomaly",
          "confidence",
        ],
        properties: {
          index: { type: "INTEGER" },
          likelyReason: { type: "STRING" },
          category: {
            type: "STRING",
            enum: [
              "live_work",
              "relationship",
              "durable_record",
              "useful_information",
              "worth_reading",
              "completed_notification",
              "temporary_or_expired",
              "marketing_or_noise",
              "unknown",
            ],
          },
          signals: { type: "ARRAY", items: { type: "STRING" } },
          anomaly: { type: "STRING" },
          confidence: { type: "NUMBER" },
        },
      },
    },
    patternNotes: { type: "ARRAY", items: { type: "STRING" } },
  },
} as const;

const SYSTEM = `You are auditing one executive's actual mail behavior.

You receive FULL readable emails from either Archive (the user kept them) or
Deleted Items (the user deleted them). Infer why the observed action made sense.
Do not turn sender shapes into rules: a no-reply sender can carry live work, and
a person can send noise. Read sender name/address, recipients, date, attachments,
and the complete body for meaning.

For each email:
- likelyReason: concrete reason this specific email was kept/deleted.
- category: choose the closest enum.
- signals: 2-5 concrete pieces of evidence from the email.
- anomaly: empty string when action fits; otherwise explain why this observed
  action is surprising (e.g. live client ask in trash, pure promotion archived).
- confidence: 0..1.

Archive is evidence of retention, not necessarily importance. It may mean a
durable record, useful information, relationship, completed work worth finding,
or live work. Trash is stronger evidence of disposability, expiry, completion,
or noise. Never assume the user's action was correct when the full email
contradicts it.

patternNotes: batch-level behavioral patterns, grounded only in this batch.`;

async function analyzeBatch(
  key: string,
  messages: AuditMessage[],
  usage: Usage,
): Promise<BatchResult> {
  const url =
    "https://generativelanguage.googleapis.com/v1beta/models/" +
    "gemini-flash-latest:generateContent";
  const body = {
    systemInstruction: { parts: [{ text: SYSTEM }] },
    contents: [
      {
        role: "user",
        parts: [
          {
            text: JSON.stringify({
              emails: messages.map((message) => ({
                index: message.index,
                observedAction: message.action,
                subject: message.subject,
                from: message.from,
                to: message.to,
                cc: message.cc,
                date: message.at,
                attachments: message.attachments,
                body: message.body,
              })),
            }),
          },
        ],
      },
    ],
    generationConfig: {
      temperature: 0,
      responseMimeType: "application/json",
      responseSchema: RESPONSE_SCHEMA,
    },
  };

  for (let attempt = 0; attempt < 4; attempt++) {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-goog-api-key": key,
      },
      body: JSON.stringify(body),
    });
    if (
      (response.status === 429 || response.status >= 500) &&
      attempt < 3
    ) {
      await new Promise((resolve) =>
        setTimeout(resolve, 2000 * 2 ** attempt),
      );
      continue;
    }
    if (!response.ok) {
      throw new Error(
        `Gemini ${response.status}: ${(await response.text()).slice(0, 250)}`,
      );
    }
    const json = (await response.json()) as {
      modelVersion?: string;
      candidates?: { content?: { parts?: { text?: string }[] } }[];
      usageMetadata?: {
        promptTokenCount?: number;
        candidatesTokenCount?: number;
        thoughtsTokenCount?: number;
        totalTokenCount?: number;
        cachedContentTokenCount?: number;
      };
    };
    const modelVersion = json.modelVersion ?? "unknown";
    usage.requests++;
    usage.modelVersions[modelVersion] =
      (usage.modelVersions[modelVersion] ?? 0) + 1;
    const meta = json.usageMetadata ?? {};
    usage.promptTokens += meta.promptTokenCount ?? 0;
    usage.outputTokens += meta.candidatesTokenCount ?? 0;
    usage.thinkingTokens += meta.thoughtsTokenCount ?? 0;
    usage.totalTokens += meta.totalTokenCount ?? 0;
    usage.cachedTokens += meta.cachedContentTokenCount ?? 0;

    const text = json.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!text) throw new Error("Gemini returned no analysis");
    return JSON.parse(text) as BatchResult;
  }
  throw new Error("Gemini analysis failed");
}

function summarizeAnalyses(
  messages: AuditMessage[],
  analyses: MessageAnalysis[],
) {
  const byIndex = new Map(messages.map((message) => [message.index, message]));
  const byAction = (action: FolderAction) =>
    analyses.filter(
      (analysis) => byIndex.get(analysis.index)?.action === action,
    );

  const categoryCounts = (rows: MessageAnalysis[]) => {
    const counts: Record<string, number> = {};
    for (const row of rows) counts[row.category] = (counts[row.category] ?? 0) + 1;
    return Object.fromEntries(
      Object.entries(counts).sort((a, b) => b[1] - a[1]),
    );
  };

  return {
    archive: {
      count: byAction("archive").length,
      categories: categoryCounts(byAction("archive")),
      anomalies: byAction("archive").filter((row) => row.anomaly.trim()),
    },
    trash: {
      count: byAction("trash").length,
      categories: categoryCounts(byAction("trash")),
      anomalies: byAction("trash").filter((row) => row.anomaly.trim()),
    },
  };
}

async function main() {
  const accountEmail = (arg("--account") ?? "").toLowerCase();
  const archiveCount = Number(arg("--archive", "100"));
  const trashCount = Number(arg("--trash", "50"));
  const outputPath = arg("--out", "/tmp/mail-action-audit.json") as string;
  const key =
    process.env.GOOGLE_GENERATIVE_AI_API_KEY ??
    process.env.GEMINI_API_KEY;
  if (!accountEmail || !key) {
    throw new Error("--account and GOOGLE_GENERATIVE_AI_API_KEY are required");
  }

  const store = await kvGet<{ accounts: StoredAccount[] }>("accounts");
  const account = (store?.accounts ?? []).find(
    (candidate) => candidate.email.toLowerCase() === accountEmail,
  );
  if (!account || account.provider === "google") {
    throw new Error("This audit currently requires the connected Outlook account");
  }
  const token = await refreshMicrosoft(account);

  console.log("Fetching complete messages (read-only)…");
  const [archive, trash] = await Promise.all([
    listFolder(token, "archive", archiveCount, "archive"),
    listFolder(token, "deleteditems", trashCount, "trash"),
  ]);
  const messages = [...archive, ...trash].map((message, index) => ({
    ...message,
    index: index + 1,
  }));
  console.log(`Fetched ${archive.length} archived + ${trash.length} trashed.`);
  // Persist the fetched corpus before any model call. If billing/quota fails,
  // the complete read-only sample is still available for offline analysis.
  const samplePath = outputPath.replace(/\.json$/, ".sample.json");
  await fs.writeFile(samplePath, JSON.stringify({ messages }, null, 2), "utf8");
  console.log(`Saved complete sample: ${samplePath}`);

  if (process.argv.includes("--fetch-only")) {
    console.log("Fetch-only requested; no model calls made.");
    return;
  }

  const usage: Usage = {
    requests: 0,
    promptTokens: 0,
    outputTokens: 0,
    thinkingTokens: 0,
    totalTokens: 0,
    cachedTokens: 0,
    modelVersions: {},
  };
  const analyses: MessageAnalysis[] = [];
  const patternNotes: string[] = [];
  const batchSize = 10;
  for (let start = 0; start < messages.length; start += batchSize) {
    const batch = messages.slice(start, start + batchSize);
    const result = await analyzeBatch(key, batch, usage);
    analyses.push(...result.analyses);
    patternNotes.push(...result.patternNotes);
    console.log(
      `Analyzed ${Math.min(start + batchSize, messages.length)}/${messages.length}`,
    );
  }

  const summary = summarizeAnalyses(messages, analyses);
  // Gemini 2.5 Flash paid-tier list price, per official pricing docs.
  // Output price includes thinking tokens.
  const pricedOutput = usage.outputTokens + usage.thinkingTokens;
  const estimatedPaidCostUsd =
    (usage.promptTokens * 0.3 + pricedOutput * 2.5) / 1_000_000;

  const report = {
    generatedAt: new Date().toISOString(),
    account: accountEmail,
    sample: { archive: archive.length, trash: trash.length },
    summary,
    patternNotes: [...new Set(patternNotes)],
    usage: {
      ...usage,
      pricedOutputTokens: pricedOutput,
      estimatedPaidCostUsd,
      pricingAssumption:
        "Gemini 2.5 Flash paid tier: $0.30/M input, $2.50/M output incl. thinking",
    },
    messages: messages.map((message) => ({
      ...message,
      analysis: analyses.find(
        (analysis) => analysis.index === message.index,
      ),
    })),
  };
  await fs.writeFile(outputPath, JSON.stringify(report, null, 2), "utf8");

  console.log("\n=== SUMMARY ===");
  console.log(JSON.stringify(summary, null, 2));
  console.log("\n=== USAGE ===");
  console.log(JSON.stringify(report.usage, null, 2));
  console.log(`\nFull report: ${outputPath}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
