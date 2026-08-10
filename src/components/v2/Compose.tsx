"use client";

import { useState } from "react";

/**
 * A focused compose panel. It owns only draft fields and hands a completed
 * message to its parent, which dispatches the send/reply command with an
 * idempotency key. Recipient derivation for replies happens server-safe in the
 * caller via the pure reply helpers.
 */
export function Compose({
  initialTo = "",
  initialSubject = "",
  initialBody = "",
  onSend,
  onCancel,
}: {
  initialTo?: string;
  initialSubject?: string;
  initialBody?: string;
  onSend: (draft: { to: string; subject: string; bodyHtml: string }) => Promise<void>;
  onCancel: () => void;
}) {
  const [to, setTo] = useState(initialTo);
  const [subject, setSubject] = useState(initialSubject);
  const [body, setBody] = useState(initialBody);
  const [sending, setSending] = useState(false);

  async function submit() {
    if (!body.trim() || sending) return;
    setSending(true);
    try {
      await onSend({ to, subject, bodyHtml: `<p>${body.replace(/\n/g, "<br/>")}</p>` });
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="seer-compose">
      <label>
        To
        <input value={to} onChange={(e) => setTo(e.target.value)} />
      </label>
      <label>
        Subject
        <input value={subject} onChange={(e) => setSubject(e.target.value)} />
      </label>
      <textarea value={body} onChange={(e) => setBody(e.target.value)} rows={10} />
      <div className="seer-compose-actions">
        <button type="button" onClick={submit} disabled={sending || !body.trim()}>
          {sending ? "Sending…" : "Send"}
        </button>
        <button type="button" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </div>
  );
}
