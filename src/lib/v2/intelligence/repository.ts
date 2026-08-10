import { inTransaction } from "../db/transaction";
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
  yields: Yield[];
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
    await client.query(
      "update seer.conversation_decisions set is_current = false where conversation_id = $1 and is_current",
      [input.conversationId],
    );

    const decided = new Date().toISOString();
    const decisionRow = await client.query<{ id: string }>(
      `insert into seer.conversation_decisions
         (account_id, conversation_id, home, proposed_home, summary, rationale,
          owner, ask, matter_id, veto_reasons, model_version, context_version,
          is_current, decided_at)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,true,$13)
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
          null,
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

export async function currentDecision(
  conversationId: ConversationId,
): Promise<ConversationDecision | null> {
  const { db } = await import("../db/pool");
  const r = await db().query(
    `select id, conversation_id, home, proposed_home, summary, rationale, owner,
            ask, matter_id, veto_reasons, model_version, context_version, decided_at
       from seer.conversation_decisions
      where conversation_id = $1 and is_current`,
    [conversationId],
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
