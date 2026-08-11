"use client";

import * as React from "react";
import { ArrowLeft, LoaderCircle } from "lucide-react";
import { useEffect, useState } from "react";
import type { Conversation, ProviderKind } from "@/lib/v2/providers/types";
import {
  Reader,
  useReaderCommands,
  type ReaderComposeIntent,
} from "@/components/v2/Reader";

type ReaderResponse = {
  conversation: Conversation;
  provider: ProviderKind;
};

export function ReaderPane({
  conversationId,
  onBack,
  onCompose,
  onNotice,
  onProviderConversationId,
  preview,
}: {
  conversationId: string;
  onBack: () => void;
  onCompose: (intent: ReaderComposeIntent) => void;
  onNotice: (message: string, error?: boolean) => void;
  onProviderConversationId?: (id: string) => void;
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
    void fetch(`/api/v3/conversations/${encodeURIComponent(conversationId)}`, {
      cache: "force-cache",
    })
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
  }, [conversationId, onProviderConversationId, preview]);

  useEffect(() => {
    if (data) onProviderConversationId?.(data.conversation.providerConversationId);
  }, [data, onProviderConversationId]);

  const commands = useReaderCommands({
    corpusConversationId: conversationId,
    onCompose,
    onCommandComplete: () => onNotice("Action queued. The provider will catch up in the background."),
  });

  const runArchive = async () => {
    try {
      await commands.onArchive();
    } catch (cause) {
      onNotice(cause instanceof Error ? cause.message : "Archive failed", true);
    }
  };

  if (loading) {
    return (
      <section className="mail-reader mail-reader-loading" aria-label="Loading conversation">
        <LoaderCircle className="mail-spinner" aria-hidden />
        <span>Opening conversation…</span>
      </section>
    );
  }
  if (error || !data) {
    return (
      <section className="mail-reader mail-reader-error" role="alert">
        <button type="button" className="mail-reader-back mail-focus-ring" onClick={onBack}>
          <ArrowLeft aria-hidden /> Back to mail
        </button>
        <p>{error ?? "Conversation unavailable"}</p>
      </section>
    );
  }

  return (
    <section className="mail-reader mail-reader-full" aria-label={`Reading ${data.conversation.subject}`}>
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
        onReply={() => onCompose({ mode: "reply" })}
        onReplyAll={() => onCompose({ mode: "replyAll" })}
        onForward={() => onCompose({ mode: "forward" })}
        onArchive={() => void runArchive()}
        onDelete={() =>
          onNotice("Delete needs a current safety token from Triage.", true)
        }
      />
    </section>
  );
}
