/**
 * Branded identifiers for the v2 relational model. A plain `string` for every
 * id lets a caller pass a conversation id where an account id is required and
 * the compiler stays silent. Branding makes those mistakes type errors while
 * remaining a zero-cost `string` at runtime.
 */

declare const brand: unique symbol;

type Branded<T, B extends string> = T & { readonly [brand]: B };

export type UserId = Branded<string, "UserId">;
export type AccountId = Branded<string, "AccountId">;
export type ConversationId = Branded<string, "ConversationId">;
export type MessageId = Branded<string, "MessageId">;
export type DecisionId = Branded<string, "DecisionId">;
export type MatterId = Branded<string, "MatterId">;

export const asUserId = (id: string): UserId => id as UserId;
export const asAccountId = (id: string): AccountId => id as AccountId;
export const asConversationId = (id: string): ConversationId =>
  id as ConversationId;
export const asMessageId = (id: string): MessageId => id as MessageId;
export const asDecisionId = (id: string): DecisionId => id as DecisionId;
export const asMatterId = (id: string): MatterId => id as MatterId;

/** The four homes a conversation can occupy. `undecided` is the safe default. */
export type Home = "matter" | "record" | "delete" | "undecided";

/** Who must act next on a conversation. */
export type Owner = "you" | "team" | "them" | "nobody";
