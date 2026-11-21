/**
 * Choose the displayed body of a Gmail MIME tree the way a mail client does.
 *
 * - `multipart/alternative`: one rendering of the same content, so the html
 *   and the plain text both come from it (the last alternative that offers
 *   each, per RFC 2046 ordering by increasing fidelity).
 * - any other multipart (`mixed`, `related`, `signed`, `report`, ...): the
 *   first child that carries a body is the message; later siblings are
 *   attachments or trailing parts, never a replacement for it.
 * - attachments and `message/rfc822` parts (forwarded or embedded mail) are
 *   never walked into: their content belongs to another message.
 */

export type MimePart = {
  mimeType?: string;
  filename?: string;
  body?: { data?: string };
  headers?: { name: string; value: string }[];
  parts?: MimePart[];
};

export type MimeBody = { html?: string; text?: string };

const MAX_DEPTH = 32;

function mimeTypeOf(part: MimePart): string {
  return (part.mimeType ?? "").split(";")[0].trim().toLowerCase();
}

function isAttachment(part: MimePart): boolean {
  if (part.filename) return true;
  const disposition = part.headers?.find(
    (h) => h.name.toLowerCase() === "content-disposition",
  )?.value;
  return /^\s*attachment\b/i.test(disposition ?? "");
}

function select(part: MimePart, decode: (data: string) => string, depth: number): MimeBody {
  if (depth > MAX_DEPTH || isAttachment(part)) return {};
  const mime = mimeTypeOf(part);
  if (mime === "message/rfc822") return {};
  if (mime === "text/html") return part.body?.data ? { html: decode(part.body.data) } : {};
  if (mime === "text/plain") return part.body?.data ? { text: decode(part.body.data) } : {};
  const children = part.parts ?? [];
  if (mime === "multipart/alternative") {
    const out: MimeBody = {};
    for (const child of children) {
      const chosen = select(child, decode, depth + 1);
      if (chosen.html !== undefined) out.html = chosen.html;
      if (chosen.text !== undefined) out.text = chosen.text;
    }
    return out;
  }
  for (const child of children) {
    const chosen = select(child, decode, depth + 1);
    if (chosen.html !== undefined || chosen.text !== undefined) return chosen;
  }
  return {};
}

export function selectMimeBody(
  payload: MimePart | undefined,
  decode: (data: string) => string,
): MimeBody {
  return payload ? select(payload, decode, 0) : {};
}
