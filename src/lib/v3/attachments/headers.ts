/**
 * Safe attachment response headers. Sender-controlled MIME types and filenames
 * are never trusted for inline rendering of active content.
 */

const INLINE_SAFE = new Set([
  "application/pdf",
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
  "text/plain",
]);

const ACTIVE_PREFIXES = [
  "image/svg",
  "text/html",
  "application/xhtml",
  "application/xml",
  "text/xml",
  "text/javascript",
  "application/javascript",
  "application/ecmascript",
];

export type AttachmentResponseHeaders = {
  contentType: string;
  contentDisposition: string;
  xContentTypeOptions: "nosniff";
};

function stripControlChars(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f]/g, "");
}

/** Normalize a sender-provided MIME type against a safe allowlist. */
export function normalizeAttachmentMimeType(raw: string | null | undefined): string {
  const trimmed = stripControlChars((raw ?? "").trim().toLowerCase());
  if (!trimmed) return "application/octet-stream";
  const base = trimmed.split(";")[0]?.trim() ?? "";
  if (!base || base.includes("/") === false) return "application/octet-stream";
  if (ACTIVE_PREFIXES.some((prefix) => base.startsWith(prefix))) {
    return "application/octet-stream";
  }
  if (INLINE_SAFE.has(base)) return base;
  return "application/octet-stream";
}

function isInlineSafe(mimeType: string): boolean {
  return INLINE_SAFE.has(mimeType);
}

/** RFC 5987-safe filename for Content-Disposition. */
export function sanitizeAttachmentFilename(raw: string): string {
  const stripped = stripControlChars(raw).replace(/["\\]/g, "_").trim();
  const ascii = stripped.replace(/[^\x20-\x7e]/g, "_").replace(/\s+/g, " ").trim();
  const fallback = ascii || "attachment";
  return fallback.slice(0, 180);
}

export function attachmentResponseHeaders(
  rawMimeType: string | null | undefined,
  rawFilename: string,
): AttachmentResponseHeaders {
  const contentType = normalizeAttachmentMimeType(rawMimeType);
  const filename = sanitizeAttachmentFilename(rawFilename);
  const disposition = isInlineSafe(contentType) ? "inline" : "attachment";
  const encoded = encodeURIComponent(filename).replace(/['()]/g, escape);
  return {
    contentType,
    contentDisposition: `${disposition}; filename="${filename}"; filename*=UTF-8''${encoded}`,
    xContentTypeOptions: "nosniff",
  };
}
