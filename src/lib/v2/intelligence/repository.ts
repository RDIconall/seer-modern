import type { PoolClient } from "pg";
import { inTransaction } from "../db/transaction";
import {
  extractCodes,
  resolveMatterByRef,
  resolveMatterMatch,
} from "./matter-key";
import type { AccountId, ConversationId, Home, Owner } from "../db/types";
import {
  CONTEXT_VERSION,
  MODEL_VERSION,
  type ConversationDecision,
  type Evidence,
  type Yield,
} from "./schema";

/**
 * Persistence for conversation decisions. A decision, its evidence, and its
 * yields are written in one transaction. The partial unique index in the schema
 * guarantees exactly one current decision per conversation; here we flip the
 * previous current row off before inserting the new one.
 */

export type SaveDecisionInput = {
  accountId: AccountId;
  conversationId: ConversationId;
  home: Home;
  proposedHome: Home;
  summary: string;
  rationale: string;
  owner: Owner;
  ask?: string;
  matterId?: string | null;
  vetoReasons: string[];
  /** 0-3 salience computed from facts (see salience.ts). */
  priority?: number;
  /** A date the email stated; orders within a bucket, never promotes. */
  dueDate?: string | null;
  /** Yields may carry the matter they were resolved to, so meaning lands on it. */
  yields: (Yield & { matterId?: string | null })[];
  evidence: Evidence[];
  modelVersion?: string;
  contextVersion?: string;
};

export async function saveDecision(
  input: SaveDecisionInput,
): Promise<ConversationDecision> {
  if (!input.modelVersion && !MODEL_VERSION) {
    throw new Error("decision requires a model version");
  }
  return inTransaction(async (client) => {
    const conversation = await client.query(
      `select 1
         from seer.conversations
        where id = $1 and account_id = $2
        for update`,
      [input.conversationId, input.accountId],
    );
    if ((conversation.rowCount ?? 0) === 0) {
      throw new Error("conversation does not belong to account");
    }

    const matterIds = [
      input.matterId,
      ...input.yields.map((yieldValue) => yieldValue.matterId ?? null),
    ].filter((id): id is string => Boolean(id));
    if (matterIds.length > 0) {
      const matters = await client.query(
        `select id
           from seer.matters
          where account_id = $1 and id = any($2::uuid[])`,
        [input.accountId, matterIds],
      );
      if (matters.rowCount !== new Set(matterIds).size) {
        throw new Error("matter does not belong to account");
      }
    }

    await client.query(
      `update seer.conversation_decisions
          set is_current = false
        where account_id = $1 and conversation_id = $2 and is_current`,
      [input.accountId, input.conversationId],
    );

    const decided = new Date().toISOString();
    const decisionRow = await client.query<{ id: string }>(
      `insert into seer.conversation_decisions
         (account_id, conversation_id, home, proposed_home, summary, rationale,
          owner, ask, matter_id, veto_reasons, priority, due_date, model_version,
          context_version, is_current, decided_at)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,true,$15)
         returning id`,
      [
        input.accountId,
        input.conversationId,
        input.home,
        input.proposedHome,
        input.summary,
        input.rationale,
        input.owner,
        input.ask ?? null,
        input.matterId ?? null,
        input.vetoReasons,
        input.priority ?? 0,
        input.dueDate ?? null,
        input.modelVersion ?? MODEL_VERSION,
        input.contextVersion ?? CONTEXT_VERSION,
        decided,
      ],
    );
    const decisionId = decisionRow.rows[0].id;

    for (const e of input.evidence) {
      await client.query(
        `insert into seer.decision_evidence (decision_id, ref, provenance, detail)
           values ($1, $2, $3, $4)`,
        [decisionId, e.ref, e.provenance, e.detail ?? null],
      );
    }

    // Yields are attached to the persisted decision. Only after this commit is
    // a `delete` home allowed to be acted on (safety checks yieldPersisted).
    for (const y of input.yields) {
      await client.query(
        `insert into seer.yields
           (account_id, decision_id, conversation_id, kind, matter_id, headline, detail, evidence_ref)
           values ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [
          input.accountId,
          decisionId,
          input.conversationId,
          y.kind,
          y.matterId ?? null,
          y.headline,
          y.detail ?? null,
          y.evidenceRef ?? null,
        ],
      );
    }

    return {
      id: decisionId,
      conversationId: input.conversationId,
      home: input.home,
      proposedHome: input.proposedHome,
      summary: input.summary,
      rationale: input.rationale,
      owner: input.owner,
      ask: input.ask,
      matterId: input.matterId ?? undefined,
      vetoReasons: input.vetoReasons,
      yields: input.yields,
      modelVersion: input.modelVersion ?? MODEL_VERSION,
      contextVersion: input.contextVersion ?? CONTEXT_VERSION,
      decidedAt: decided,
    };
  });
}

/**
 * Resolve the matter a `matter` conversation belongs to: reuse an open matter
 * with the same title, otherwise create one from the read's proposed name. This
 * is the promotion step — without it a conversation the brain called live work
 * has no home on the board.
 */
export async function ensureMatter(
  accountId: AccountId,
  title: string,
  tie?: { text: string; counterparty: string; own?: Set<string> },
): Promise<string> {
  const clean = title.trim().slice(0, 120) || "Untitled matter";
  return inTransaction(async (client) => {
    // Tie this conversation to the unit of work it belongs to: a shared study
    // or event code is proof; otherwise the counterparty must match and the
    // requests must overlap. Falls back to exact title when no tie info given.
    if (tie) {
      const open = await client.query<{
        id: string;
        title: string;
        counterparty: string | null;
        codes: string[] | null;
        title_source: string | null;
      }>(
        `select m.id, m.title, m.org_unit as counterparty, m.title_source,
                array_remove(array_agg(distinct mc.code), null) as codes
           from seer.matters m
           left join seer.matter_codes mc on mc.matter_id = m.id
          where m.account_id = $1 and m.status <> 'closed'
          group by m.id, m.title, m.org_unit, m.title_source`,
        [accountId],
      );
      const match = resolveMatterMatch(
        { title: clean, text: tie.text, counterparty: tie.counterparty, own: tie.own },
        open.rows.map((r) => ({
          matterId: r.id,
          title: r.title,
          codes: r.codes ?? [],
          counterparty: r.counterparty ?? "",
          userAuthored: r.title_source === "user",
        })),
      );
      if (match) {
        await recordCodes(client, match.matterId, extractCodes(tie.text));
        return match.matterId;
      }
      const created = await client.query<{ id: string }>(
        "insert into seer.matters (account_id, title, org_unit) values ($1, $2, $3) returning id",
        [accountId, clean, tie.counterparty || null],
      );
      await recordCodes(client, created.rows[0].id, extractCodes(tie.text));
      return created.rows[0].id;
    }

    const existing = await client.query<{ id: string }>(
      "select id from seer.matters where account_id = $1 and lower(title) = lower($2) and status <> 'closed' limit 1",
      [accountId, clean],
    );
    if (existing.rows[0]) return existing.rows[0].id;
    const created = await client.query<{ id: string }>(
      "insert into seer.matters (account_id, title) values ($1, $2) returning id",
      [accountId, clean],
    );
    return created.rows[0].id;
  });
}

/** Remember the codes a matter is known by, so later mail ties to it. */
async function recordCodes(
  client: PoolClient,
  matterId: string,
  codes: string[],
): Promise<void> {
  for (const code of codes) {
    await client.query(
      "insert into seer.matter_codes (matter_id, code) values ($1, $2) on conflict do nothing",
      [matterId, code],
    );
  }
}

/**
 * Find an EXISTING matter a yield refers to. Deliberately never creates one: a
 * passing mention in a newsletter should attach to the Roche matter if it
 * exists, but must not invent a matter out of a mention.
 */
export async function findMatterByRef(
  accountId: AccountId,
  ref: string,
): Promise<string | null> {
  const { db } = await import("../db/pool");
  const open = await db().query<{
    id: string;
    title: string;
    counterparty: string | null;
    codes: string[] | null;
  }>(
    `select m.id, m.title, m.org_unit as counterparty,
            array_remove(array_agg(distinct mc.code), null) as codes
       from seer.matters m
       left join seer.matter_codes mc on mc.matter_id = m.id
      where m.account_id = $1 and m.status <> 'closed'
      group by m.id, m.title, m.org_unit`,
    [accountId],
  );
  const match = resolveMatterByRef(
    ref,
    open.rows.map((r) => ({
      matterId: r.id,
      title: r.title,
      codes: r.codes ?? [],
      counterparty: r.counterparty ?? "",
    })),
  );
  return match?.matterId ?? null;
}

/**
 * Link a conversation to a matter (idempotent).
 *
 * A link that is already there is the desired state, so it counts as done. It
 * used to count as nothing: `do nothing` reports no rows, which was read as
 * "does not belong to this account" and thrown. Since the AI reader links every
 * conversation it promotes, filing one of those into Atlas by hand — the
 * ordinary case — hit that throw and the user was told the request had failed.
 *
 * Only the count of rows still distinguishes ownership: no row matches the
 * select when the matter or the conversation is not this account's.
 *
 * A user placing mail somewhere outranks a sweep that guessed the same, so the
 * source is upgraded and never downgraded.
 */
export async function linkConversationToMatter(
  accountId: AccountId,
  matterId: string,
  conversationId: ConversationId,
  source: "inferred" | "user" = "inferred",
): Promise<void> {
  const { db } = await import("../db/pool");
  const result = await db().query(
    `insert into seer.matter_conversations (matter_id, conversation_id, link_source)
       select m.id, c.id, $3
         from seer.matters m
         join seer.conversations c on c.id = $2 and c.account_id = $1
        where m.id = $4 and m.account_id = $1
       on conflict (matter_id, conversation_id) do update
          set link_source = case
                when seer.matter_conversations.link_source = 'user' then 'user'
                else excluded.link_source
              end`,
    [accountId, conversationId, source, matterId],
  );
  if ((result.rowCount ?? 0) === 0) {
    throw new Error("matter or conversation does not belong to account");
  }
}

export async function currentDecision(
  accountId: AccountId,
  conversationId: ConversationId,
): Promise<ConversationDecision | null> {
  const { db } = await import("../db/pool");
  const r = await db().query(
    `select id, conversation_id, home, proposed_home, summary, rationale, owner,
            ask, matter_id, veto_reasons, model_version, context_version, decided_at
       from seer.conversation_decisions
      where account_id = $1 and conversation_id = $2 and is_current`,
    [accountId, conversationId],
  );
  const row = r.rows[0];
  if (!row) return null;
  return {
    id: row.id,
    conversationId: row.conversation_id,
    home: row.home,
    proposedHome: row.proposed_home,
    summary: row.summary,
    rationale: row.rationale,
    owner: row.owner,
    ask: row.ask ?? undefined,
    matterId: row.matter_id ?? undefined,
    vetoReasons: row.veto_reasons,
    yields: [],
    modelVersion: row.model_version,
    contextVersion: row.context_version,
    decidedAt: new Date(row.decided_at).toISOString(),
  };
}
