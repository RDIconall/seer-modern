/**
 * A recipient suggestion for compose.
 *
 * Ranking matters far more than recall here: the address the user wants should
 * be the first suggestion, not the twentieth, so the score blends who they
 * actually correspond with against who merely appears in their mail.
 */
export type ContactSuggestion = {
  email: string;
  displayName: string | null;
  /** Relationship tier from the person graph. */
  tier: string;
  vip: boolean;
  /** How many messages have passed between the user and this address. */
  exchanges: number;
};
