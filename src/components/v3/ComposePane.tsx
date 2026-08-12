"use client";

import * as React from "react";
import { useEffect, useId, useState } from "react";
import { ChevronDown, ChevronRight, X } from "lucide-react";
import { MessageHtml } from "@/components/v2/MessageHtml";
import type { ReaderComposeIntent } from "@/components/v2/Reader";
import type { CommandResult } from "@/lib/v2/commands/types";
import type { Conversation, ProviderKind } from "@/lib/v2/providers/types";
import {
  hasAttachments,
  quoteHeaderLines,
  quotedMessages,
} from "@/lib/v3/compose/quoted-thread";
import { fetchDefault } from "@/lib/v3/net/fetch";
import {
  canSendCompose,
  dispatchCommand,
  needsRecipient,
  type ComposeMode,
} from "./compose-command";
import { RecipientInput } from "./RecipientInput";
import type { Recipient } from "./recipient-state";

function modeFromIntent(intent?: ReaderComposeIntent | { mode: "send" }): ComposeMode {
  return intent?.mode ?? "send";
}

function modeTitle(mode: ComposeMode): string {
  if (mode === "replyAll") return "Reply all";
  return mode[0].toUpperCase() + mode.slice(1);
}

type ConversationResponse = {
  conversation: Conversation;
  provider?: ProviderKind;
  error?: string;
};

/**
 * Whether the thread's attachments travel with a forward.
 *
 * Graph forwards the original message, attachments and all. Gmail forwards are
 * assembled as a new message from the provider contract, which carries no
 * attachment bytes, so they are silently left behind — and someone forwarding a
 * signed contract needs telling before they send it, not after.
 */
function attachmentsSurviveForward(provider: ProviderKind | null): boolean {
  return provider === "microsoft";
}

/**
 * Outlook-style compose: recipient pills with contact autocomplete, an optional
 * subject, the note the user types, then the quoted thread they are about to
 * pass on. The quoted block is read-only and sanitised through MessageHtml —
 * quoted mail is untrusted content.
 */
export function ComposePane({
  intent,
  providerConversationId,
  conversationId,
  accountId,
  preview,
  previewProvider,
  onClose,
  onSent,
}: {
  intent?: ReaderComposeIntent | { mode: "send" };
  providerConversationId?: string;
  /** Corpus conversation id — used to fetch the thread for quoting. */
  conversationId?: string;
  accountId?: string;
  /** Fixture / already-loaded conversation; skips the network when present. */
  preview?: Conversation;
  previewProvider?: ProviderKind;
  onClose: () => void;
  onSent: (result: CommandResult) => void;
}) {
  const mode = modeFromIntent(intent);
  const title = modeTitle(mode);
  const showTo = mode === "send" || mode === "forward";
  const showSubject = mode === "send" || mode === "forward";
  const showQuote = mode === "reply" || mode === "replyAll" || mode === "forward";
  const forwardSubjectReadOnly = mode === "forward";

  const [recipients, setRecipients] = useState<Recipient[]>([]);
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [conversation, setConversation] = useState<Conversation | null>(preview ?? null);
  const [provider, setProvider] = useState<ProviderKind | null>(previewProvider ?? null);
  const [quoteFailed, setQuoteFailed] = useState(false);
  const [quoteLoading, setQuoteLoading] = useState(Boolean(showQuote && !preview && conversationId));
  // Forward must open expanded so the user can see what they are sending.
  const [quoteOpen, setQuoteOpen] = useState(mode === "forward");

  const toLabelId = useId();
  const subjectId = useId();
  const subjectHintId = useId();
  const toInputId = useId();
  const bodyId = useId();

  useEffect(() => {
    if (preview) {
      setConversation(preview);
      setProvider(previewProvider ?? null);
      setQuoteLoading(false);
      setQuoteFailed(false);
      return;
    }
    if (!showQuote || !conversationId) {
      setQuoteLoading(false);
      return;
    }
    let cancelled = false;
    setQuoteLoading(true);
    setQuoteFailed(false);
    const scope = accountId ? `?account=${encodeURIComponent(accountId)}` : "";
    void fetchDefault(`/api/v3/conversations/${encodeURIComponent(conversationId)}${scope}`)
      .then(async (response) => {
        const json = (await response.json()) as ConversationResponse;
        if (!response.ok) throw new Error(json.error ?? `conversation ${response.status}`);
        return json;
      })
      .then((next) => {
        if (!cancelled) {
          setConversation(next.conversation);
          setProvider(next.provider ?? null);
          setQuoteFailed(false);
        }
      })
      .catch(() => {
        // A failed quote fetch must not block typing or sending.
        if (!cancelled) {
          setQuoteFailed(true);
          setConversation(null);
        }
      })
      .finally(() => {
        if (!cancelled) setQuoteLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [accountId, conversationId, preview, previewProvider, showQuote]);

  const derivedForwardSubject = conversation
    ? `FW: ${conversation.subject}`
    : "FW:";
  const subjectValue = forwardSubjectReadOnly ? derivedForwardSubject : subject;
  const threadHasAttachments = conversation ? hasAttachments(conversation) : false;
  const quoted = conversation ? quotedMessages(conversation) : [];

  const canSend = canSendCompose({
    mode,
    recipientCount: recipients.length,
    body,
    sending,
  });

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!canSend) return;
    setSending(true);
    setError(null);
    try {
      const bodyHtml = `<p>${body.replace(/\n/g, "<br/>")}</p>`;
      const to = recipients.map((r) => r.email);
      let result: CommandResult;
      if (mode === "send") {
        result = await dispatchCommand({
          type: "send",
          to,
          subject: subjectValue,
          bodyHtml,
        });
      } else if (mode === "forward") {
        if (!providerConversationId) throw new Error("conversation required");
        result = await dispatchCommand({
          type: "forward",
          providerConversationId,
          to,
          bodyHtml,
        });
      } else {
        if (!providerConversationId) throw new Error("conversation required");
        result = await dispatchCommand({
          type: "reply",
          providerConversationId,
          all: mode === "replyAll",
          bodyHtml,
        });
      }
      onSent(result);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not send");
    } finally {
      setSending(false);
    }
  }

  const actionLabel =
    mode === "forward"
      ? "Forward"
      : mode === "replyAll"
        ? "Reply all"
        : mode === "reply"
          ? "Reply"
          : "Send";

  return (
    <aside
      className="mail-compose"
      role="dialog"
      aria-modal="true"
      aria-labelledby="mail-compose-title"
    >
      <header className="mail-compose-header">
        <h2 id="mail-compose-title">{title}</h2>
        <button
          type="button"
          className="mail-close mail-focus-ring"
          aria-label="Close compose"
          onClick={onClose}
        >
          <X aria-hidden />
        </button>
      </header>

      <form className="mail-compose-form" onSubmit={(event) => void submit(event)}>
        {showTo && (
          <div className="mail-compose-row">
            <label id={toLabelId} className="mail-compose-label" htmlFor={toInputId}>
              To
            </label>
            <RecipientInput
              id={toInputId}
              labelledBy={toLabelId}
              recipients={recipients}
              onChange={setRecipients}
            />
          </div>
        )}

        {showSubject && (
          <div className="mail-compose-row">
            <label className="mail-compose-label" htmlFor={subjectId}>
              Subject
            </label>
            <input
              id={subjectId}
              className="mail-compose-subject mail-focus-ring"
              type="text"
              value={subjectValue}
              onChange={(event) => setSubject(event.target.value)}
              readOnly={forwardSubjectReadOnly}
              aria-describedby={forwardSubjectReadOnly ? subjectHintId : undefined}
            />
          </div>
        )}
        {forwardSubjectReadOnly && (
          <p id={subjectHintId} className="mail-compose-hint">
            The subject of a forward is set when it is sent.
          </p>
        )}

        <label className="mail-compose-body-label" htmlFor={bodyId}>
          Message
        </label>
        <textarea
          id={bodyId}
          className="mail-compose-body mail-focus-ring"
          value={body}
          onChange={(event) => setBody(event.target.value)}
          rows={8}
        />

        {showQuote && (
          <section className="mail-compose-quote" aria-label="Quoted conversation">
            <div className="mail-compose-quote-divider" />
            {mode === "forward" &&
              threadHasAttachments &&
              !attachmentsSurviveForward(provider) && (
                <p className="mail-compose-attach-warn" role="status">
                  Attachments from the original thread are not included in this
                  forward.
                </p>
              )}
            <button
              type="button"
              className="mail-compose-quote-toggle mail-focus-ring"
              aria-expanded={quoteOpen}
              onClick={() => setQuoteOpen((open) => !open)}
            >
              {quoteOpen ? <ChevronDown aria-hidden /> : <ChevronRight aria-hidden />}
              <span>
                {quoteLoading
                  ? "Loading conversation…"
                  : quoteFailed
                    ? "Conversation unavailable"
                    : quoteOpen
                      ? "Hide conversation"
                      : "Show conversation"}
              </span>
            </button>
            {quoteOpen && conversation && (
              <div className="mail-compose-quote-thread">
                {quoted.map((message) => {
                  const headers = quoteHeaderLines(message, conversation.subject);
                  return (
                    <article
                      key={message.providerMessageId}
                      className="mail-compose-quote-message"
                    >
                      <dl className="mail-compose-quote-headers">
                        {headers.map((line) => (
                          <div key={line.label} className="mail-compose-quote-header-line">
                            <dt>{line.label}:</dt>
                            <dd>{line.value}</dd>
                          </div>
                        ))}
                      </dl>
                      <MessageHtml html={message.bodyHtml} text={message.bodyText} />
                    </article>
                  );
                })}
              </div>
            )}
          </section>
        )}

        {error && (
          <p className="mail-compose-error" role="alert">
            {error}
          </p>
        )}

        <div className="mail-compose-actions">
          <button
            type="submit"
            className="mail-action mail-focus-ring"
            disabled={!canSend}
            title={
              needsRecipient(mode) && recipients.length === 0
                ? "Add at least one recipient"
                : undefined
            }
          >
            {sending ? "Sending…" : actionLabel}
          </button>
          <button
            type="button"
            className="mail-action mail-focus-ring"
            onClick={onClose}
          >
            Cancel
          </button>
        </div>
      </form>
    </aside>
  );
}
