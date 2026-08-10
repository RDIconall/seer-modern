"use client";

import type { Conversation } from "@/lib/v2/providers/types";
import type { ProviderKind } from "@/lib/v2/providers/types";
import { nativeUrlFor } from "@/lib/v2/providers/native-url";
import { MessageHtml } from "./MessageHtml";
import { ConversationActions } from "./ConversationActions";

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
                  <li key={a.id}>{a.filename}</li>
                ))}
              </ul>
            )}
          </li>
        ))}
      </ol>
    </article>
  );
}
