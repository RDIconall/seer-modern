/**
 * Attachment response header security: active MIME types and CRLF filenames
 * must never be served inline.
 */
import assert from "node:assert/strict";
import {
  attachmentResponseHeaders,
  normalizeAttachmentMimeType,
  sanitizeAttachmentFilename,
} from "../src/lib/v3/attachments/headers.ts";

// SVG must never be inline — normalized to octet-stream and forced attachment.
{
  const headers = attachmentResponseHeaders("image/svg+xml", "logo.svg");
  assert.equal(headers.contentType, "application/octet-stream");
  assert.match(headers.contentDisposition, /^attachment;/);
  assert.equal(headers.xContentTypeOptions, "nosniff");
}

// HTML/XHTML must never be inline.
for (const mime of ["text/html", "application/xhtml+xml"]) {
  const headers = attachmentResponseHeaders(mime, "page.html");
  assert.equal(headers.contentType, "application/octet-stream");
  assert.match(headers.contentDisposition, /^attachment;/);
}

// Bogus MIME falls back to octet-stream and attachment disposition.
{
  const headers = attachmentResponseHeaders("not-a-real-type", "file.bin");
  assert.equal(headers.contentType, "application/octet-stream");
  assert.match(headers.contentDisposition, /^attachment;/);
}

// Safe types may be inline.
{
  const headers = attachmentResponseHeaders("application/pdf", "brief.pdf");
  assert.equal(headers.contentType, "application/pdf");
  assert.match(headers.contentDisposition, /^inline;/);
}

// CRLF injection in filename is stripped.
{
  const filename = sanitizeAttachmentFilename('evil"\r\nContent-Type: text/html\r\n\r\n.pdf');
  assert.ok(!filename.includes("\r"));
  assert.ok(!filename.includes("\n"));
  const headers = attachmentResponseHeaders("application/pdf", filename);
  assert.ok(!headers.contentDisposition.includes("\r"));
  assert.ok(!headers.contentDisposition.includes("\n"));
}

assert.equal(normalizeAttachmentMimeType("text/javascript"), "application/octet-stream");
assert.equal(normalizeAttachmentMimeType("image/jpeg"), "image/jpeg");

console.log("v3-attachment-security: OK");
