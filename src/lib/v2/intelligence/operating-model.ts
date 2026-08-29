import { generateText, Output } from "ai";
import { z } from "zod";
import { db } from "../db/pool";
import type { AccountId } from "../db/types";
import type { MailProvider, SyncFolder } from "../providers/types";
import { loadSalesforce } from "@/lib/store/salesforce";
import { recordModelUsage } from "./model-usage";
import {
  MAX_FUNCTIONS,
  MAX_TOPICS,
  listRegistry,
  replaceRegistry,
  sanitizeSectionNames,
} from "./functions";

export const MAX_GUIDANCE_CHARS = 2000;

export type SectionDraft = { name: string; why: string };

export type OperatingProposal = {
  functions: SectionDraft[];
  topics: SectionDraft[];
  guidance: string;
  rationale: string;
};

export type OperatingModelState = {
  functions: string[];
  topics: string[];
  guidance: string;
  proposal: OperatingProposal | null;
  proposedAt: string | null;
  acceptedAt: string | null;
};

export type CorpusLine = {
  bucket: string;
  subject: string;
  from: string;
  snippet: string;
};

export type OperatingCorpus = {
  lines: CorpusLine[];
  counts: Record<string, number>;
  salesforce: {
    opportunities: number;
    studies: number;
    sample: string[];
  };
};

const proposalSchema = z.object({
  functions: z.array(
    z.object({
      name: z.string(),
      why: z.string(),
    }),
  ),
  topics: z.array(
    z.object({
      name: z.string(),
      why: z.string(),
    }),
  ),
  guidance: z.string(),
  rationale: z.string(),
});

export const OPERATING_MODEL_SYSTEM = `You design the split-inbox shelves for ONE person's Atlas board.

Atlas has two axes:
- FUNCTIONS: parts of THIS person's real work or life that they track as live concerns (the work they own). 4–10 short names. Examples for a CEO might be "recruiting" or "sales — contracting"; for a personal mailbox "house", "family", "money", "travel". Never copy a company org chart the evidence does not support.
- TOPICS: what leftover mail IS when it is not anyone's live work (newsletters, receipts, shipping, social). 3–8 names.

Rules:
- Name shelves the way this person would say them. Lowercase is fine. No org-chart jargon unless the evidence is a company desk.
- FUNCTIONS are for work they still carry. TOPICS are for mail they already throw away or never act on.
- Use SENT mail to see what they initiate, TRASH to see what they discard, SAVED/STARRED to see what they keep, INBOX for what is still open, SALESFORCE for commercial objects they actually own.
- If Salesforce is empty or missing, ignore it. If the mailbox looks personal, do not invent "operations — studies".
- guidance is 2–6 sentences the filing model will treat as law: what counts as a matter vs a topic, what to never delete, how to tell similar shelves apart.
- Return only shelves the evidence supports. Do not pad to a quota.`;

const BUCKET_LIMIT = 40;
const SNIPPET = 160;

export function normalizeProposal(
  raw: OperatingProposal,
): OperatingProposal {
  const functions = uniqueDrafts(raw.functions, MAX_FUNCTIONS);
  const topics = uniqueDrafts(raw.topics, MAX_TOPICS);
  return {
    functions,
    topics,
    guidance: raw.guidance.trim().slice(0, MAX_GUIDANCE_CHARS),
    rationale: raw.rationale.trim().slice(0, 800),
  };
}

function uniqueDrafts(drafts: SectionDraft[], limit: number): SectionDraft[] {
  const names = sanitizeSectionNames(
    drafts.map((d) => d.name),
    limit,
  );
  const byKey = new Map<string, SectionDraft>();
  for (const d of drafts) {
    const name = d.name.replace(/\s+/g, " ").trim();
    const key = name.toLowerCase();
    if (!byKey.has(key)) {
      byKey.set(key, {
        name,
        why: d.why.trim().slice(0, 160),
      });
    }
  }
  return names.map((name) => {
    const found = byKey.get(name.toLowerCase());
    return { name, why: found?.why ?? "" };
  });
}

export async function loadOperatingModel(
  accountId: AccountId,
): Promise<OperatingModelState> {
  const [functions, topics, row] = await Promise.all([
    listRegistry(accountId, "function"),
    listRegistry(accountId, "topic"),
    db().query<{
      guidance: string;
      proposal: OperatingProposal | null;
      proposed_at: Date | null;
      accepted_at: Date | null;
    }>(
      `select guidance, proposal, proposed_at, accepted_at
         from seer.operating_models
        where account_id = $1`,
      [accountId],
    ),
  ]);
  const model = row.rows[0];
  return {
    functions,
    topics,
    guidance: model?.guidance ?? "",
    proposal: model?.proposal ?? null,
    proposedAt: model?.proposed_at?.toISOString() ?? null,
    acceptedAt: model?.accepted_at?.toISOString() ?? null,
  };
}

export async function loadGuidance(accountId: AccountId): Promise<string> {
  const r = await db().query<{ guidance: string }>(
    `select guidance from seer.operating_models where account_id = $1`,
    [accountId],
  );
  return r.rows[0]?.guidance?.trim() ?? "";
}

export async function saveProposal(
  accountId: AccountId,
  proposal: OperatingProposal,
): Promise<void> {
  await db().query(
    `insert into seer.operating_models (account_id, proposal, proposed_at, updated_at)
     values ($1, $2::jsonb, now(), now())
     on conflict (account_id) do update
       set proposal = excluded.proposal,
           proposed_at = now(),
           updated_at = now()`,
    [accountId, JSON.stringify(proposal)],
  );
}

export async function applyOperatingModel(
  accountId: AccountId,
  input: { functions: string[]; topics: string[]; guidance: string },
): Promise<OperatingModelState> {
  const guidance = input.guidance.trim().slice(0, MAX_GUIDANCE_CHARS);
  const replaced = await replaceRegistry(
    accountId,
    input.functions,
    input.topics,
  );
  await db().query(
    `insert into seer.operating_models
       (account_id, guidance, accepted_at, updated_at)
     values ($1, $2, now(), now())
     on conflict (account_id) do update
       set guidance = excluded.guidance,
           accepted_at = now(),
           updated_at = now()`,
    [accountId, guidance],
  );
  const state = await loadOperatingModel(accountId);
  return {
    ...state,
    functions: replaced.functions,
    topics: replaced.topics,
    guidance,
  };
}

export async function sampleCorpus(
  accountId: AccountId,
  accountEmail: string,
  provider?: MailProvider,
): Promise<OperatingCorpus> {
  const lines: CorpusLine[] = [];
  const counts: Record<string, number> = {};

  const add = (bucket: string, subject: string, from: string, snippet: string) => {
    counts[bucket] = (counts[bucket] ?? 0) + 1;
    if ((counts[`${bucket}:kept`] ?? 0) >= BUCKET_LIMIT) return;
    counts[`${bucket}:kept`] = (counts[`${bucket}:kept`] ?? 0) + 1;
    lines.push({
      bucket,
      subject: subject.slice(0, 120),
      from: from.slice(0, 80),
      snippet: snippet.slice(0, SNIPPET),
    });
  };

  const stored = await db().query<{
    subject: string | null;
    from_email: string | null;
    snippet: string | null;
    folders: string[];
    is_deleted: boolean;
  }>(
    `select c.subject, c.is_deleted, c.folders,
            (select m.from_email from seer.messages m
              where m.conversation_id = c.id
              order by m.sent_at desc nulls last limit 1) as from_email,
            (select left(coalesce(m.snippet, m.body_text, ''), 160)
               from seer.messages m
              where m.conversation_id = c.id
              order by m.sent_at desc nulls last limit 1) as snippet
       from seer.conversations c
      where c.account_id = $1
      order by c.last_message_at desc nulls last
      limit 400`,
    [accountId],
  );

  for (const row of stored.rows) {
    const folders = row.folders ?? [];
    if (folders.includes("sent")) {
      add("sent", row.subject ?? "", row.from_email ?? "", row.snippet ?? "");
    }
    if (folders.includes("trash") || row.is_deleted) {
      add("trash", row.subject ?? "", row.from_email ?? "", row.snippet ?? "");
    }
    if (folders.includes("inbox") && !row.is_deleted) {
      add("inbox", row.subject ?? "", row.from_email ?? "", row.snippet ?? "");
    }
  }

  const matters = await db().query<{ title: string; function_name: string | null }>(
    `select title, function_name from seer.matters
      where account_id = $1 and status <> 'closed'
      order by updated_at desc
      limit 40`,
    [accountId],
  );
  for (const m of matters.rows) {
    add("matter", m.title, m.function_name ?? "", "");
  }

  if (provider) {
    await sampleProviderFolder(provider, "sent", add);
    await sampleProviderFolder(provider, "trash", add);
    try {
      const saved = await provider.search("label:STARRED", null);
      for (const c of saved.conversations.slice(0, BUCKET_LIMIT)) {
        const last = c.messages[c.messages.length - 1];
        add(
          "saved",
          c.subject,
          last?.from.email ?? "",
          last?.snippet || last?.bodyText || "",
        );
      }
    } catch {
      /* Outlook has no Gmail STARRED label; sent/trash still count. */
    }
  }

  const sf = await loadSalesforce(accountEmail);
  const sample = [
    ...sf.opportunities.slice(0, 15).map((o) =>
      [o.code, o.name, o.account, o.stage].filter(Boolean).join(" — "),
    ),
    ...sf.studies.slice(0, 15).map((s) =>
      [s.code, s.name, s.account].filter(Boolean).join(" — "),
    ),
  ].filter(Boolean);

  return {
    lines,
    counts: Object.fromEntries(
      Object.entries(counts).filter(([k]) => !k.includes(":kept")),
    ),
    salesforce: {
      opportunities: sf.opportunities.length,
      studies: sf.studies.length,
      sample,
    },
  };
}

async function sampleProviderFolder(
  provider: MailProvider,
  folder: SyncFolder,
  add: (bucket: string, subject: string, from: string, snippet: string) => void,
): Promise<void> {
  try {
    const page = await provider.syncFolder(folder, null);
    for (const c of page.conversations.slice(0, BUCKET_LIMIT)) {
      const last = c.messages[c.messages.length - 1];
      add(
        folder,
        c.subject,
        last?.from.email ?? "",
        last?.snippet || last?.bodyText || "",
      );
    }
  } catch {
    /* A missing folder must not fail the proposal. */
  }
}

export type ProposeCaller = (
  corpus: OperatingCorpus,
  note?: string,
) => Promise<OperatingProposal>;

export const defaultProposeCaller: ProposeCaller = async (corpus, note) => {
  const model =
    process.env.SEER_ROUTER_STRONG_MODEL?.trim() ||
    "anthropic/claude-sonnet-4.6";
  const result = await generateText({
    model,
    temperature: 0.2,
    maxRetries: 0,
    abortSignal: AbortSignal.timeout(90_000),
    output: Output.object({ schema: proposalSchema }),
    providerOptions: {
      gateway: { caching: "auto" },
    },
    system: OPERATING_MODEL_SYSTEM,
    prompt: JSON.stringify({
      note: note?.trim() || undefined,
      salesforce: corpus.salesforce,
      counts: corpus.counts,
      mail: corpus.lines,
    }),
  });
  return normalizeProposal(result.output);
};

export async function proposeOperatingModel(
  accountId: AccountId,
  accountEmail: string,
  options: {
    provider?: MailProvider;
    note?: string;
    caller?: ProposeCaller;
  } = {},
): Promise<{ state: OperatingModelState; corpus: OperatingCorpus }> {
  const corpus = await sampleCorpus(accountId, accountEmail, options.provider);
  const started = Date.now();
  const caller = options.caller ?? defaultProposeCaller;
  const proposal = normalizeProposal(await caller(corpus, options.note));
  if (proposal.functions.length === 0) {
    throw new Error("The model did not propose any Atlas sections");
  }
  await saveProposal(accountId, proposal);
  await recordModelUsage({
    accountId,
    tier: "strong",
    model: process.env.SEER_ROUTER_STRONG_MODEL?.trim() || "anthropic/claude-sonnet-4.6",
    escalationReasons: ["operating_model"],
    latencyMs: Date.now() - started,
  }).catch(() => {});
  return { state: await loadOperatingModel(accountId), corpus };
}
