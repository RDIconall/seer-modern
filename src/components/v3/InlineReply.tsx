"use client";

import * as React from "react";
import { useCallback, useEffect, useId, useState } from "react";
import { Expand, Sparkles } from "lucide-react";
import type { CommandResult } from "@/lib/v2/commands/types";
import type { Conversation } from "@/lib/v2/providers/types";
import type { ReaderComposeIntent } from "@/components/v2/Reader";
import {
  canSendCompose,
  dispatchCommand,
  needsRecipient,
} from "./compose-command";
import { describeHttpFailure, readJsonBody } from "@/lib/v3/net/json";
import { RecipientInput } from "./RecipientInput";
import type { Recipient } from "./recipient-state";
import { RichComposer, type RichComposerValue } from "./RichComposer";
import {
  draftStorageKey,
  parseStoredDraft,
  type StoredDraft,
} from "@/lib/v3/compose/draft";

const EMPTY_RICH: RichComposerValue = { html: "", text: "" };

const modeLabel = (mode: ReaderComposeIntent["mode"]) =>
  mode === "replyAll" ? "Reply all" : mode[0].toUpperCase() + mode.slice(1);

export function InlineReply({
  conversation,
  providerConversationId,
  accountId,
  intent,
  onActivate,
  onClose,
  onExpand,
  onSent,
}: {
  conversation: Conversation;
  providerConversationId: string;
  accountId?: string;
  intent: ReaderComposeIntent | null;
  onActivate: (intent: ReaderComposeIntent) => void;
  onClose: () => void;
  onExpand: (intent: ReaderComposeIntent) => void;
  onSent: (result: CommandResult) => void;
}) {
  const [body, setBody] = useState<RichComposerValue>(EMPTY_RICH);
  const [recipients, setRecipients] = useState<Recipient[]>([]);
  const [sending, setSending] = useState(false);
  const [drafting, setDrafting] = useState(false);
  const [saved, setSaved] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const recipientLabelId = useId();
  const recipientInputId = useId();
  const mode = intent?.mode ?? "reply";
  const activeMode = intent?.mode;
  const draftKey = draftStorageKey(accountId, mode, providerConversationId);
  const latest = conversation.messages.at(-1);

  const saveDraft = useCallback(() => {
    const draft: StoredDraft = {
      recipients: recipients.map((recipient) => recipient.email),
      subject: "",
      bodyHtml: body.html,
      bodyText: body.text,
      savedAt: new Date().toISOString(),
    };
    window.localStorage.setItem(draftKey, JSON.stringify(draft));
  }, [body, draftKey, recipients]);

  useEffect(() => {
    if (!activeMode) return;
    const draft = parseStoredDraft(window.localStorage.getItem(draftKey));
    setBody(
      draft
        ? { html: draft.bodyHtml, text: draft.bodyText }
        : EMPTY_RICH,
    );
    setRecipients(
      (draft?.recipients ?? []).map((email) => ({
        email,
        displayName: email,
      })),
    );
    setSaved(draft ? "Draft restored" : null);
    setError(null);
  }, [activeMode, draftKey]);

  useEffect(() => {
    if (!activeMode || (!body.text && recipients.length === 0)) return;
    const timer = window.setTimeout(() => {
      saveDraft();
      setSaved("Draft saved");
    }, 500);
    return () => window.clearTimeout(timer);
  }, [activeMode, body, draftKey, recipients, saveDraft]);

  async function draftWithAi() {
    if (!latest?.providerMessageId || drafting) return;
    setDrafting(true);
    setError(null);
    try {
      const response = await fetch("/api/assist/draft", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: latest.providerMessageId }),
      });
      const json = await readJsonBody<{ body?: string; error?: string }>(
        response,
      );
      if (!response.ok || !json?.body) {
        throw new Error(
          json?.error ??
            (response.ok ? "Draft failed" : describeHttpFailure(response.status)),
        );
      }
      const html = `<p>${json.body
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replace(/\n/g, "<br>")}</p>`;
      setBody({ html, text: json.body });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Draft failed");
    } finally {
      setDrafting(false);
    }
  }

  const canSend =
    intent !== null &&
    canSendCompose({
      mode,
      recipientCount: recipients.length,
      body: body.text,
      sending,
    });

  async function submit() {
    if (!intent || !canSend) return;
    setSending(true);
    setError(null);
    try {
      const bodyHtml = body.html || "<p></p>";
      const result =
        mode === "forward"
          ? await dispatchCommand({
              type: "forward",
              providerConversationId,
              to: recipients.map((recipient) => recipient.email),
              bodyHtml,
            })
          : await dispatchCommand({
              type: "reply",
              providerConversationId,
              all: mode === "replyAll",
              bodyHtml,
            });
      window.localStorage.removeItem(draftKey);
      setBody(EMPTY_RICH);
      setRecipients([]);
      onSent(result);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not send");
    } finally {
      setSending(false);
    }
  }

  if (!intent) {
    return (
      <section className="inline-reply" aria-label="Reply to conversation">
        <div className="inline-reply-collapsed">
          <button
            type="button"
            className="mail-focus-ring"
            onClick={() => onActivate({ mode: "reply" })}
          >
            Reply
          </button>
          <button
            type="button"
            className="mail-focus-ring"
            onClick={() => onActivate({ mode: "replyAll" })}
          >
            Reply all
          </button>
          <button
            type="button"
            className="mail-focus-ring"
            onClick={() => onActivate({ mode: "forward" })}
          >
            Forward
          </button>
        </div>
      </section>
    );
  }

  return (
    <section className="inline-reply inline-reply-open" aria-label={modeLabel(mode)}>
      <div className="inline-reply-modes" role="tablist" aria-label="Message action">
        {(["reply", "replyAll", "forward"] as const).map((nextMode) => (
          <button
            key={nextMode}
            type="button"
            role="tab"
            aria-selected={mode === nextMode}
            className="mail-focus-ring"
            onClick={() => onActivate({ mode: nextMode })}
          >
            {modeLabel(nextMode)}
          </button>
        ))}
      </div>

      <p className="inline-reply-context">
        {mode === "forward"
          ? "Forward this conversation"
          : `${modeLabel(mode)} to ${latest?.from.name || latest?.from.email || "sender"}`}
      </p>

      {mode === "forward" ? (
        <div className="inline-reply-recipient">
          <label id={recipientLabelId} htmlFor={recipientInputId}>
            To
          </label>
          <RecipientInput
            id={recipientInputId}
            labelledBy={recipientLabelId}
            recipients={recipients}
            onChange={setRecipients}
          />
        </div>
      ) : null}

      <form
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
        onKeyDown={(event) => {
          if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
            event.preventDefault();
            void submit();
          } else if (event.key === "Escape") {
            event.preventDefault();
            onClose();
          }
        }}
      >
        <div className="inline-reply-editor">
          <RichComposer
            key={mode}
            value={body}
            onChange={setBody}
            placeholder={`Write a ${modeLabel(mode).toLowerCase()}…`}
            autoFocus
          />
        </div>

        <div className="inline-reply-extras">
          <button
            type="button"
            className="mail-focus-ring"
            disabled={drafting}
            onClick={() => void draftWithAi()}
          >
            <Sparkles aria-hidden />
            {drafting ? "Drafting…" : "Draft with AI"}
          </button>
          {saved ? <span>{saved}</span> : null}
        </div>

        {error ? (
          <p className="mail-compose-error" role="alert">
            {error}
          </p>
        ) : null}

        <div className="inline-reply-actions">
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
            {sending ? "Sending…" : modeLabel(mode)}
          </button>
          <button
            type="button"
            className="mail-focus-ring"
            onClick={() => {
              saveDraft();
              onExpand(intent);
            }}
          >
            <Expand aria-hidden />
            Expand
          </button>
          <button type="button" className="mail-focus-ring" onClick={onClose}>
            Cancel
          </button>
          <span className="inline-reply-shortcut">⌘/Ctrl + Enter to send</span>
        </div>
      </form>
    </section>
  );
}
