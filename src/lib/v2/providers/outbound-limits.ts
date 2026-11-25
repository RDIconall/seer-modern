import {
  assertOutbound,
  MAX_OUTBOUND_HEADER_CHARS,
  outboundAttachmentsError,
  outboundRecipientsError,
  outboundTextError,
} from "@/lib/mail/outbound-limits";
import type { ForwardCommand, ReplyCommand, SendCommand } from "./types";

export function sendCommandError(command: {
  to: unknown;
  cc?: unknown;
  bcc?: unknown;
  subject: unknown;
  bodyHtml: unknown;
  attachments?: unknown;
}): string | null {
  return (
    outboundRecipientsError("to", command.to) ??
    outboundRecipientsError("cc", command.cc) ??
    outboundRecipientsError("bcc", command.bcc) ??
    outboundTextError("subject", command.subject, {
      max: MAX_OUTBOUND_HEADER_CHARS,
      optional: true,
    }) ??
    outboundTextError("bodyHtml", command.bodyHtml) ??
    outboundAttachmentsError(command.attachments)
  );
}

export function replyCommandError(command: { bodyHtml: unknown }): string | null {
  return outboundTextError("bodyHtml", command.bodyHtml);
}

export function forwardCommandError(command: { to: unknown; bodyHtml: unknown }): string | null {
  return outboundRecipientsError("to", command.to) ?? outboundTextError("bodyHtml", command.bodyHtml);
}

export function assertSendCommand(command: SendCommand): void {
  assertOutbound(sendCommandError(command));
}

export function assertReplyCommand(command: ReplyCommand): void {
  assertOutbound(replyCommandError(command));
}

export function assertForwardCommand(command: ForwardCommand): void {
  assertOutbound(forwardCommandError(command));
}
