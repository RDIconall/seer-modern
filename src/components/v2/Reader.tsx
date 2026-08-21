"use client";

import * as React from "react";
import { useMemo, useState } from "react";
import type { Conversation } from "@/lib/v2/providers/types";
import type { ProviderKind } from "@/lib/v2/providers/types";
import { nativeUrlFor } from "@/lib/v2/providers/native-url";
import {
  conversationFiles,
  participants,
  shapeThread,
  summariseThread,
  type Turn,
} from "@/lib/v3/reader/thread-shape";
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
const shortDate = (iso: string) => {
  const at = Date.parse(iso);
  if (Number.isNaN(at)) return "";
  return new Date(at).toLocaleDateString(undefined, { month: "short", day: "numeric" });
};

const fileKind = (filename: string) =>
  (filename.split(".").pop() ?? "file").slice(0, 4).toUpperCase();

const fileSize = (bytes: number) =>
  bytes >= 1_000_000
    ? `${(bytes / 1_000_000).toFixed(1)} MB`
    : `${Math.max(1, Math.round(bytes / 1000))} KB`;

/**
 * The reading pane. A thread has two lanes and every mail client flattens them
 * into one: the trunk is what the counterparty can see, a branch is the forward
 * to a colleague and everything it produced. Kept apart, you can follow what the
 * customer knows without reading your own team's working out.
 *
 * Turns are closed by default with one line showing, and their bodies carry new
 * text only — the quoted history is counted instead, because re-reading the same
 * paragraph six times down a thread is what makes long threads unreadable.
 */
export function Reader({
  provider,
  conversation,
  ownEmail,
  onReply,
  onReplyAll,
  onForward,
  onArchive,
  onDelete,
}: {
  provider: ProviderKind;
  conversation: Conversation;
  ownEmail?: string | null;
  onReply: () => void;
  onReplyAll: () => void;
  onForward: () => void;
  onArchive: () => void;
  onDelete: () => void;
}) {
  const nativeUrl = nativeUrlFor(provider, conversation.providerConversationId, {
    messageId: conversation.messages[conversation.messages.length - 1]?.providerMessageId,
  });
  const ownDomain = (ownEmail ?? "").split("@")[1] ?? "";
  const lanes = useMemo(
    () => shapeThread(conversation, ownDomain, ownEmail),
    [conversation, ownDomain, ownEmail],
  );
  const files = useMemo(() => conversationFiles(conversation), [conversation]);
  const people = useMemo(
    () => participants(conversation, ownDomain, ownEmail),
    [conversation, ownDomain, ownEmail],
  );
  const summary = useMemo(
    () => summariseThread(conversation, ownDomain, ownEmail),
    [conversation, ownDomain, ownEmail],
  );

  // The newest turn stands open; the rest are one line each until asked for.
  const lastTurnKey = [...lanes]
    .reverse()
    .find((lane) => lane.kind === "turn") as Turn | undefined;
  const [open, setOpen] = useState<ReadonlySet<string>>(
    () => new Set(lastTurnKey ? [lastTurnKey.message.providerMessageId] : []),
  );
  const toggle = (key: string) =>
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  const dropped = people.filter((person) => person.droppedOff);

  return (
    <article className="seer-reader">
      <header className="reader-head">
        <h1 className="reader-matter">{conversation.subject}</h1>
        <p className="reader-sub">
          {summary.external + summary.internal} messages · {summary.people} people
          {summary.internal > 0 ? ` · ${summary.internal} internal` : ""}
        </p>
        {summary.waitingOn && summary.daysUnanswered !== null && (
          <div className="reader-ball">
            <span>
              {summary.waitingOn} wrote {summary.daysUnanswered === 0
                ? "today"
                : `${summary.daysUnanswered} day${summary.daysUnanswered === 1 ? "" : "s"} ago`}{" "}
              and has had no reply.
            </span>
            <button type="button" className="reader-ball-action mail-focus-ring" onClick={onReply}>
              Reply
            </button>
          </div>
        )}
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

      {files.length > 0 && (
        <div className="reader-files" aria-label="Files on this conversation">
          {files.map((file) => (
            <a
              key={`${file.messageId}:${file.attachmentId}`}
              className="reader-file mail-focus-ring"
              href={attachmentUrl(file.messageId, file.attachmentId)}
            >
              <span className="reader-file-kind tabular">{fileKind(file.filename)}</span>
              <span>
                <b>{file.filename}</b>
                <em className="tabular">
                  {file.versions > 1
                    ? `${file.versions} versions`
                    : fileSize(file.sizeBytes)}
                </em>
              </span>
            </a>
          ))}
        </div>
      )}

      <div className="reader-lane">
        {lanes.map((lane, index) => {
          if (lane.kind === "branch") {
            const key = `branch:${lane.turns[0].message.providerMessageId}`;
            const isOpen = open.has(key);
            return (
              <section key={key} className="reader-branch" data-open={isOpen}>
                <button
                  type="button"
                  className="reader-branch-head mail-focus-ring"
                  aria-expanded={isOpen}
                  onClick={() => toggle(key)}
                >
                  <span className="reader-branch-tag tabular">INTERNAL</span>
                  <span className="reader-branch-title">You forwarded to {lane.to}</span>
                  <span className="reader-branch-count tabular">{lane.turns.length}</span>
                </button>
                {isOpen && (
                  <div className="reader-branch-inner">
                    {lane.turns.map((turn) => (
                      <div key={turn.message.providerMessageId} className="reader-branch-turn">
                        <div className="reader-branch-from">
                          <b>{turn.who}</b>
                          <em className="tabular">{shortDate(turn.message.sentAt)}</em>
                        </div>
                        <div className="reader-branch-text">
                          <MessageHtml html={turn.html} text={turn.text} />
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </section>
            );
          }

          const key = lane.message.providerMessageId;
          const isOpen = open.has(key);
          return (
            <section key={key} className="reader-turn" data-open={isOpen} data-last={index === lanes.length - 1}>
              <button
                type="button"
                className="reader-turn-head mail-focus-ring"
                aria-expanded={isOpen}
                onClick={() => toggle(key)}
              >
                <span className={`reader-turn-who${lane.isYou ? " reader-turn-you" : ""}`}>
                  {lane.who}
                </span>
                {!isOpen && <span className="reader-turn-peek">{lane.peek}</span>}
                <span className="reader-turn-when tabular">{shortDate(lane.message.sentAt)}</span>
              </button>
              {isOpen && (
                <div className="reader-turn-body">
                  <MessageHtml html={lane.bodyHtml} text={lane.body} />
                  {lane.quotedCount > 0 && (
                    <p className="reader-stripped tabular">
                      {lane.quotedCount} quoted message
                      {lane.quotedCount > 1 ? "s" : ""} hidden
                    </p>
                  )}
                </div>
              )}
            </section>
          );
        })}
      </div>

      <section className="reader-people">
        <h2 className="atlas-heading">On this</h2>
        <div className="reader-chips">
          {people.map((person) => (
            <span
              key={person.email}
              className={`reader-chip${person.droppedOff ? " reader-chip-out" : ""}`}
            >
              {person.name}
              {person.org ? <em className="tabular">{person.org}</em> : null}
            </span>
          ))}
        </div>
        {dropped.length > 0 && (
          <p className="reader-people-note">
            {dropped.map((person) => person.name).join(", ")}
            {dropped.length === 1 ? " was" : " were"} on this earlier and{" "}
            {dropped.length === 1 ? "has" : "have"} not been on it since.
          </p>
        )}
      </section>

      <p className="reader-foot tabular">
        {summary.external} with {conversation.messages[0]?.from.name ?? "them"} ·{" "}
        {summary.internal} internal
        {summary.daysUnanswered !== null
          ? ` · ${summary.daysUnanswered} days since they were answered`
          : ""}
      </p>
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
    // Reading a conversation and pressing Delete is as explicit as it gets. If
    // Seer happens to have cleared it too, send that clearance along; if it did
    // not, the user's decision still stands.
    onDelete: () =>
      dispatchCommand(
        deleteToken
          ? { type: "delete", conversationId: corpusConversationId, deleteToken }
          : { type: "delete", conversationId: corpusConversationId, byUser: true },
      ),
    dispatchCommand,
  };
}
