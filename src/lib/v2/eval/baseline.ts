import type { Conversation } from "../providers/types";
import type { BaselineResult } from "./types";

/**
 * The baseline read: what you'd get by pasting the full email into a general
 * chat with no knowledge of the user's business. It sees the whole thread but
 * no relationships, matters, CRM, or interests. Seer must never do worse than
 * this. The judging model is injected so the baseline is deterministic in tests.
 */

export type BaselineModel = (conversation: Conversation) => Promise<BaselineResult>;

export async function runBaseline(
  conversation: Conversation,
  model: BaselineModel,
): Promise<BaselineResult> {
  return model(conversation);
}
