"use client";

import * as React from "react";
import type { ReaderMessage } from "@/lib/inbox/types";
import {
  addToHistory,
  shownBody,
  startHistory,
} from "@/lib/v3/reader/thread-shape";
import { MailReader } from "./MailReader";
import { QuotedFold } from "./QuotedFold";

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

  const history = startHistory(reader.subject);
  const shown = turns.map((turn) => {
    const body = {
      bodyHtml: turn.htmlBody || null,
      bodyText: turn.textBody || null,
      snippet: "",
    };
    const result = shownBody(body, history);
    addToHistory(history, body, [
      turn.fromName,
      turn.fromEmail,
      reader.toEmail,
      reader.ccEmail,
    ]);
    return result;
  });

  return (
    <div className="legacy-thread" aria-label="Conversation">
      {turns.map((turn, index) => {
        const body = shown[index];
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
                html={body.quotedCount === 0 ? turn.htmlBody : null}
                text={body.text}
              />
              {body.quotedCount > 0 && (
                <QuotedFold
                  count={body.quotedCount}
                  html={turn.htmlBody}
                  text={body.fullText}
                />
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
