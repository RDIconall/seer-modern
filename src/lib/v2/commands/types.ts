import type { Home } from "../db/types";

/**
 * The command vocabulary — the only way to change anything. Every command is
 * account-scoped, carries an idempotency key, and returns a result the client
 * renders. Business placement is never expressed as a raw field; a delete must
 * present a signed decision token the server minted.
 */

export type Command =
  /**
   * Two ways to delete, and the difference is who decided.
   *
   * `deleteToken` is Seer's own clearance, signed against the current decision,
   * and it is what a pile-level sweep carries: an automated action over mail the
   * user has not looked at individually must not be able to reach past what the
   * safety layer allowed.
   *
   * `byUser` is a person selecting a conversation and pressing Delete. That is
   * their mail and their call, and it is not second-guessed — the same principle
   * `correctConversation` already works on. Seer's judgement constrains Seer,
   * not the person it works for.
   */
  | {
      type: "delete";
      conversationId: string;
      deleteToken?: string | null;
      byUser?: boolean;
    }
  | { type: "archive"; conversationId: string }
  | { type: "restore"; conversationId: string }
  | { type: "markUnread"; conversationId: string }
  | {
      type: "move";
      providerConversationId: string;
      destinationId: string;
    }
  | { type: "reorderMatters"; section: string; matterIds: string[] }
  | {
      type: "moveMatter";
      matterId: string;
      fromSection: string;
      toSection: string;
      sourceMatterIds: string[];
      targetMatterIds: string[];
    }
  | { type: "correctConversation"; conversationId: string; home: Home; note?: string }
  | { type: "teachSender"; email: string; instruction: "vip" | "always_delete" | "never_delete" }
  | {
      type: "send";
      to: string[];
      subject: string;
      bodyHtml: string;
      attachments?: {
        filename: string;
        mimeType: string;
        contentBase64: string;
        sizeBytes: number;
      }[];
    }
  | { type: "reply"; providerConversationId: string; all: boolean; bodyHtml: string }
  | { type: "forward"; providerConversationId: string; to: string[]; bodyHtml: string };

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
  /** Outbound command reserved but provider outcome not yet recorded. */
  pending?: boolean;
  /** Outbound command may have succeeded before crash — do not resend. */
  unknown?: boolean;
};
