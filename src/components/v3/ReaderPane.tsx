"use client";

import * as React from "react";
import { ArrowLeft, LoaderCircle } from "lucide-react";
import { useEffect, useState } from "react";
import type { Conversation, ProviderKind } from "@/lib/v2/providers/types";
import { fetchDefault } from "@/lib/v3/net/fetch";
import {
  Reader,
  useReaderCommands,
  type ReaderComposeIntent,
} from "@/components/v2/Reader";

type ReaderResponse = {
  conversation: Conversation;
  provider: ProviderKind;
  /** The account's own address, which tells the two lanes of a thread apart. */
  ownEmail?: string | null;
};

export function ReaderPane({
  conversationId,
  onBack,
  onCompose,
  onNotice,
  onCommandComplete,
  onProviderConversationId,
  accountId,
  preview,
}: {
  conversationId: string;
  onBack: () => void;
  onCompose: (intent: ReaderComposeIntent) => void;
  onNotice: (message: string, error?: boolean) => void;
  onCommandComplete?: () => void;
  onProviderConversationId?: (id: string) => void;
  accountId?: string;
  preview?: ReaderResponse;
}) {
  const [data, setData] = useState<ReaderResponse | null>(preview ?? null);
  const [loading, setLoading] = useState(!preview);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (preview) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    const scope = accountId ? `?account=${encodeURIComponent(accountId)}` : "";
    void fetchDefault(`/api/v3/conversations/${encodeURIComponent(conversationId)}${scope}`)
      .then(async (response) => {
        const json = (await response.json()) as ReaderResponse & { error?: string };
        if (!response.ok) throw new Error(json.error ?? `conversation ${response.status}`);
        return json;
      })
      .then((json) => {
        if (!cancelled) {
          setData(json);
          onProviderConversationId?.(json.conversation.providerConversationId);
        }
      })
      .catch((cause) => {
        if (!cancelled) setError(cause instanceof Error ? cause.message : "reader failed");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [accountId, conversationId, onProviderConversationId, preview]);

  useEffect(() => {
    if (data) onProviderConversationId?.(data.conversation.providerConversationId);
  }, [data, onProviderConversationId]);

  const commands = useReaderCommands({
    corpusConversationId: conversationId,
    onCompose,
    onCommandComplete: () => {
      onNotice("Action queued. The provider will catch up in the background.");
      onCommandComplete?.();
    },
  });

  const runArchive = async () => {
    try {
      await commands.onArchive();
    } catch (cause) {
      onNotice(cause instanceof Error ? cause.message : "Archive failed", true);
    }
  };

  const runDelete = async () => {
    try {
      await commands.onDelete();
    } catch (cause) {
      onNotice(cause instanceof Error ? cause.message : "Delete failed", true);
    }
  };

  if (loading) {
    return (
      <section
        className="mail-reader mail-reader-full mail-reader-loading"
        role="dialog"
        aria-modal="true"
        aria-label="Loading conversation"
      >
        <button type="button" className="mail-reader-back mail-focus-ring" onClick={onBack}>
          <ArrowLeft aria-hidden />
          <span>Back to mail</span>
        </button>
        <LoaderCircle className="mail-spinner" aria-hidden />
        <span>Opening conversation…</span>
      </section>
    );
  }
  if (error || !data) {
    return (
      <section
        className="mail-reader mail-reader-full mail-reader-error"
        role="dialog"
        aria-modal="true"
        aria-label="Conversation unavailable"
      >
        <button type="button" className="mail-reader-back mail-focus-ring" onClick={onBack}>
          <ArrowLeft aria-hidden /> Back to mail
        </button>
        <p>{error ?? "Conversation unavailable"}</p>
      </section>
    );
  }

  return (
    <section
      className="mail-reader mail-reader-full"
      role="dialog"
      aria-modal="true"
      aria-label={`Reading ${data.conversation.subject}`}
    >
      <header className="mail-reader-header">
        <button type="button" className="mail-reader-back mail-focus-ring" onClick={onBack}>
          <ArrowLeft aria-hidden />
          <span>Back</span>
        </button>
        <span className="mail-reader-status">Conversation</span>
      </header>
      <Reader
        provider={data.provider}
        conversation={data.conversation}
        ownEmail={data.ownEmail}
        onReply={() => onCompose({ mode: "reply" })}
        onReplyAll={() => onCompose({ mode: "replyAll" })}
        onForward={() => onCompose({ mode: "forward" })}
        onArchive={() => void runArchive()}
        onDelete={() => void runDelete()}
      />
    </section>
  );
}
