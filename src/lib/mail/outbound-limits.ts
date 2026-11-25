/**
 * Server-side ceilings for outbound mail. The composers cap files at 3 MB, but
 * every send path also receives JSON straight from a caller, and building a
 * Gmail MIME document or a Graph request multiplies the payload several times
 * over. These checks run on the caller's strings only — no decoding, wrapping
 * or re-encoding — so a refused payload costs nothing beyond its own bytes.
 */
import type { SendMailInput } from "@/lib/mail/types";

export const MAX_OUTBOUND_ATTACHMENTS = 5;
export const MAX_ATTACHMENT_BYTES = 3_000_000;
export const MAX_OUTBOUND_BODY_CHARS = 3_000_000;
/** Subject and recipient lists are headers; nothing legitimate comes close. */
export const MAX_OUTBOUND_HEADER_CHARS = 100_000;

const MAX_ATTACHMENT_BASE64_CHARS = Math.ceil(MAX_ATTACHMENT_BYTES / 3) * 4;
const MAX_FILENAME_CHARS = 1_000;
const MAX_MIME_TYPE_CHARS = 255;
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

export class OutboundLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OutboundLimitError";
  }
}

/** Bytes `Buffer.from(value, "base64")` would produce for a strict-alphabet string. */
function decodedBase64Bytes(value: string): number {
  let padding = 0;
  if (value.endsWith("==")) padding = 2;
  else if (value.endsWith("=")) padding = 1;
  return Math.floor(((value.length - padding) * 3) / 4);
}

export function outboundAttachmentsError(attachments: unknown): string | null {
  if (attachments === undefined || attachments === null) return null;
  if (!Array.isArray(attachments)) return "Invalid attachment";
  if (attachments.length > MAX_OUTBOUND_ATTACHMENTS) {
    return `At most ${MAX_OUTBOUND_ATTACHMENTS} attachments`;
  }
  for (const attachment of attachments as unknown[]) {
    if (!attachment || typeof attachment !== "object") return "Invalid attachment";
    const { filename, mimeType, contentBase64, sizeBytes } = attachment as Record<
      string,
      unknown
    >;
    if (
      typeof filename !== "string" ||
      filename.length === 0 ||
      filename.length > MAX_FILENAME_CHARS ||
      typeof mimeType !== "string" ||
      mimeType.length > MAX_MIME_TYPE_CHARS ||
      typeof sizeBytes !== "number" ||
      !Number.isFinite(sizeBytes) ||
      sizeBytes < 0 ||
      sizeBytes > MAX_ATTACHMENT_BYTES ||
      typeof contentBase64 !== "string" ||
      contentBase64.length > MAX_ATTACHMENT_BASE64_CHARS ||
      !BASE64.test(contentBase64) ||
      decodedBase64Bytes(contentBase64) > MAX_ATTACHMENT_BYTES
    ) {
      return "Invalid attachment";
    }
  }
  return null;
}

export function outboundTextError(
  label: string,
  value: unknown,
  { max = MAX_OUTBOUND_BODY_CHARS, optional = false }: { max?: number; optional?: boolean } = {},
): string | null {
  if (value === undefined || value === null) return optional ? null : `${label} required`;
  if (typeof value !== "string") return `Invalid ${label}`;
  if (value.length > max) return `${label} too large`;
  return null;
}

/** Recipient lists as strings or `{ email }` addresses, measured together. */
export function outboundRecipientsError(label: string, recipients: unknown): string | null {
  if (recipients === undefined || recipients === null) return null;
  if (typeof recipients === "string") {
    return outboundTextError(label, recipients, { max: MAX_OUTBOUND_HEADER_CHARS });
  }
  if (!Array.isArray(recipients)) return `Invalid ${label}`;
  let total = 0;
  for (const recipient of recipients as unknown[]) {
    const email =
      typeof recipient === "string"
        ? recipient
        : recipient && typeof recipient === "object"
          ? (recipient as { email?: unknown }).email
          : undefined;
    if (typeof email !== "string") return `Invalid ${label}`;
    total += email.length + 2;
    if (total > MAX_OUTBOUND_HEADER_CHARS) return `${label} too large`;
  }
  return null;
}

export function assertOutbound(...errors: (string | null)[]): void {
  const error = errors.find((candidate) => candidate !== null);
  if (error) throw new OutboundLimitError(error);
}

export function assertSendMailInput(input: SendMailInput): void {
  assertOutbound(
    outboundRecipientsError("to", input.to),
    outboundRecipientsError("cc", input.cc),
    outboundTextError("subject", input.subject, {
      max: MAX_OUTBOUND_HEADER_CHARS,
      optional: true,
    }),
    outboundTextError("body", input.body),
    outboundTextError("html", input.html, { optional: true }),
    outboundAttachmentsError(input.attachments),
  );
}
