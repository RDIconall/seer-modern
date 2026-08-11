"use client";

import type { Conversation } from "@/lib/v2/providers/types";
import type { ProviderKind } from "@/lib/v2/providers/types";
import { nativeUrlFor } from "@/lib/v2/providers/native-url";
import { MessageHtml } from "./MessageHtml";
import { ConversationActions } from "./ConversationActions";

/** Build a v3 attachment download URL for a provider message attachment. */
export function attachmentUrl(providerMessageId: string, attachmentId: string): string {
  return `/api/v3/messages/${encodeURIComponent(providerMessageId)}/attachments/${encodeURIComponent(attachmentId)}`;
}

export type ReaderComposeIntent =
  | { mode: "reply" }
  | { mode: "replyAll" }
  | { mode: "forward" };

/**
 * The reading pane: the full conversation in order, one action row, then the
 * messages. Everything shown comes from the server; the reader computes no
 * placement of its own.
 */
export function Reader({
  provider,
  conversation,
  onReply,
  onReplyAll,
  onForward,
  onArchive,
  onDelete,
}: {
  provider: ProviderKind;
  conversation: Conversation;
  onReply: () => void;
  onReplyAll: () => void;
  onForward: () => void;
  onArchive: () => void;
  onDelete: () => void;
}) {
  const nativeUrl = nativeUrlFor(provider, conversation.providerConversationId);
  return (
    <article className="seer-reader">
      <header>
        <h1>{conversation.subject}</h1>
      </header>
      <ConversationActions
        provider={provider}
        nativeUrl={nativeUrl}
        onReply={onReply}
        onReplyAll={onReplyAll}
        onForward={onForward}
        onArchive={onArchive}
        onDelete={onDelete}
      />
      <ol className="seer-thread">
        {conversation.messages.map((message) => (
          <li key={message.providerMessageId} className="seer-message">
            <div className="seer-message-head">
              <span className="seer-from">
                {message.from.name || message.from.email}
              </span>
              <span className="seer-when">{message.sentAt}</span>
            </div>
            <MessageHtml html={message.bodyHtml} text={message.bodyText} />
            {message.attachments.length > 0 && (
              <ul className="seer-attachments">
                {message.attachments.map((a) => (
                  <li key={a.id}>
                    <a href={attachmentUrl(message.providerMessageId, a.id)}>
                      {a.filename}
                    </a>
                  </li>
                ))}
              </ul>
            )}
          </li>
        ))}
      </ol>
    </article>
  );
}

export type ReaderCommandOptions = {
  corpusConversationId: string;
  deleteToken?: string;
  onCompose: (intent: ReaderComposeIntent) => void;
  onCommandComplete?: () => void;
};

/**
 * Wire reader actions to the v2 command bus: reply/reply-all open compose;
 * archive/delete dispatch mutation commands immediately (corpus conversation id).
 */
export function useReaderCommands({
  corpusConversationId,
  deleteToken,
  onCompose,
  onCommandComplete,
}: ReaderCommandOptions) {
  async function dispatchCommand(command: import("@/lib/v2/commands/types").Command) {
    const res = await fetch("/api/v2/commands", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        command,
        idempotencyKey:
          globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`,
      }),
    });
    const json = (await res.json()) as {
      result: import("@/lib/v2/commands/types").CommandResult;
    };
    if (!res.ok || !json.result.ok) {
      throw new Error(json.result?.error ?? `command ${res.status}`);
    }
    onCommandComplete?.();
    return json.result;
  }

  return {
    onReply: () => onCompose({ mode: "reply" }),
    onReplyAll: () => onCompose({ mode: "replyAll" }),
    onForward: () => onCompose({ mode: "forward" }),
    onArchive: () =>
      dispatchCommand({
        type: "archive",
        conversationId: corpusConversationId,
      }),
    onDelete: () => {
      if (!deleteToken) {
        throw new Error("delete token required");
      }
      return dispatchCommand({
        type: "delete",
        conversationId: corpusConversationId,
        deleteToken,
      });
    },
    dispatchCommand,
  };
}
