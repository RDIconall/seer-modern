"use client";

import * as React from "react";
import type { ReaderMessage } from "@/lib/inbox/types";
import { MailReader } from "./MailReader";

function freshText(text: string): { text: string; quoted: boolean } {
  const marker =
    /^(?:On .+wrote:|From:\s.+|-----Original Message-----|_{5,})$/im;
  const match = marker.exec(text);
  if (!match?.index) return { text, quoted: false };
  return { text: text.slice(0, match.index).trim(), quoted: true };
}

export function LegacyThread({ reader }: { reader: ReaderMessage }) {
  const turns =
    reader.thread && reader.thread.length > 0
      ? reader.thread
      : [
          {
            id: "current",
            htmlBody: reader.htmlBody,
            textBody: reader.textBody,
            fromName: reader.fromName,
            fromEmail: reader.fromEmail,
            receivedAt: reader.receivedAt,
            attachments: reader.attachments,
          },
        ];

  return (
    <div className="legacy-thread" aria-label="Conversation">
      {turns.map((turn, index) => {
        const fresh = freshText(turn.textBody);
        const htmlContainsQuote =
          /(?:gmail_quote|blockquote|Original Message)/i.test(turn.htmlBody);
        return (
          <details
            key={turn.id}
            className="legacy-thread-turn"
            open={index === turns.length - 1}
          >
            <summary>
              <span>{turn.fromName || turn.fromEmail}</span>
              <time>{turn.receivedAt ? new Date(turn.receivedAt).toLocaleString() : ""}</time>
            </summary>
            <div className="legacy-thread-body">
              <MailReader
                html={fresh.quoted || htmlContainsQuote ? null : turn.htmlBody}
                text={fresh.text || turn.textBody}
              />
              {(fresh.quoted || htmlContainsQuote) && (
                <p className="reader-stripped">Quoted history hidden</p>
              )}
              {turn.attachments?.length ? (
                <div className="legacy-thread-files">
                  {turn.attachments.map((attachment) => (
                    <a
                      key={attachment.id}
                      href={`/api/messages/${encodeURIComponent(turn.id)}/attachment?aid=${encodeURIComponent(attachment.id)}&name=${encodeURIComponent(attachment.filename)}&type=${encodeURIComponent(attachment.mimeType)}`}
                    >
                      {attachment.filename}
                    </a>
                  ))}
                </div>
              ) : null}
            </div>
          </details>
        );
      })}
    </div>
  );
}
