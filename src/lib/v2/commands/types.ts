import type { Home } from "../db/types";

/**
 * The command vocabulary — the only way to change anything. Every command is
 * account-scoped, carries an idempotency key, and returns a result the client
 * renders. Business placement is never expressed as a raw field; a delete must
 * present a signed decision token the server minted.
 */

export type Command =
  | { type: "delete"; conversationId: string; deleteToken: string }
  | { type: "archive"; conversationId: string }
  | { type: "restore"; conversationId: string }
  | { type: "markUnread"; conversationId: string }
  | { type: "correctConversation"; conversationId: string; home: Home; note?: string }
  | { type: "teachSender"; email: string; instruction: "vip" | "always_delete" | "never_delete" }
  | { type: "send"; to: string[]; subject: string; bodyHtml: string }
  | { type: "reply"; conversationId: string; all: boolean; bodyHtml: string }
  | { type: "forward"; conversationId: string; to: string[]; bodyHtml: string };

export type CommandResult = {
  ok: boolean;
  replayed: boolean;
  processed?: string[];
  failed?: string[];
  error?: string;
  detail?: Record<string, unknown>;
  /** Present when the command was enqueued to the write-behind outbox. */
  outboxId?: string;
  optimistic?: boolean;
};
