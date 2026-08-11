"use client";

import { useState } from "react";
import type { Command, CommandResult } from "@/lib/v2/commands/types";

export type ComposeMode = "send" | "reply" | "replyAll" | "forward";

/** Dispatch one command to the v2 command bus with a fresh idempotency key. */
export async function dispatchCommand(command: Command): Promise<CommandResult> {
  const res = await fetch("/api/v2/commands", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      command,
      idempotencyKey:
        globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`,
    }),
  });
  const json = (await res.json()) as { result: CommandResult };
  if (!res.ok || !json.result.ok) {
    throw new Error(json.result?.error ?? `command ${res.status}`);
  }
  return json.result;
}

function parseRecipients(raw: string): string[] {
  return raw
    .split(/[,;]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * A focused compose panel. It owns draft fields and dispatches send/reply/forward
 * commands with an idempotency key. Recipient derivation for replies happens
 * server-safe via provider conversation id.
 */
export function Compose({
  mode = "send",
  providerConversationId,
  initialTo = "",
  initialSubject = "",
  initialBody = "",
  onSend,
  onCancel,
  onComplete,
}: {
  mode?: ComposeMode;
  /** Provider conversation id for reply/forward commands. */
  providerConversationId?: string;
  initialTo?: string;
  initialSubject?: string;
  initialBody?: string;
  onSend?: (draft: { to: string; subject: string; bodyHtml: string }) => Promise<void>;
  onCancel: () => void;
  onComplete?: (result: CommandResult) => void;
}) {
  const [to, setTo] = useState(initialTo);
  const [subject, setSubject] = useState(initialSubject);
  const [body, setBody] = useState(initialBody);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const showTo = mode === "send" || mode === "forward";
  const showSubject = mode === "send";

  async function submit() {
    if (!body.trim() || sending) return;
    setSending(true);
    setError(null);
    try {
      const bodyHtml = `<p>${body.replace(/\n/g, "<br/>")}</p>`;
      if (onSend) {
        await onSend({ to, subject, bodyHtml });
        return;
      }
      let result: CommandResult;
      if (mode === "send") {
        result = await dispatchCommand({
          type: "send",
          to: parseRecipients(to),
          subject,
          bodyHtml,
        });
      } else if (mode === "forward") {
        if (!providerConversationId) throw new Error("conversation required");
        result = await dispatchCommand({
          type: "forward",
          providerConversationId,
          to: parseRecipients(to),
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
      onComplete?.(result);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not send");
    } finally {
      setSending(false);
    }
  }

  const label =
    mode === "forward"
      ? "Forward"
      : mode === "replyAll"
        ? "Reply all"
        : mode === "reply"
          ? "Reply"
          : "Send";

  return (
    <div className="seer-compose">
      {showTo && (
        <label>
          To
          <input value={to} onChange={(e) => setTo(e.target.value)} />
        </label>
      )}
      {showSubject && (
        <label>
          Subject
          <input value={subject} onChange={(e) => setSubject(e.target.value)} />
        </label>
      )}
      <label>
        Message
        <textarea
          value={body}
          onChange={(e) => setBody(e.target.value)}
          rows={10}
          aria-label="Message"
        />
      </label>
      {error && <p role="alert">{error}</p>}
      <div className="seer-compose-actions">
        <button type="button" onClick={submit} disabled={sending || !body.trim()}>
          {sending ? "Sending…" : label}
        </button>
        <button type="button" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </div>
  );
}
