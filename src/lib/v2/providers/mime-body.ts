/**
 * Picks the body a mail client would display from a Gmail MIME tree.
 *
 * Only one part of the tree is the message. A multipart/alternative holds
 * renditions of that one body; any other multipart (mixed, related, signed,
 * report) leads with its body and follows with attachments, inline resources,
 * or further parts that are not the message. Attachments and embedded
 * message/rfc822 parts are never read as the body, so a forwarded message or
 * a later sibling part cannot stand in for the outer one.
 */

export type MimePart = {
  mimeType?: string;
  filename?: string;
  headers?: { name: string; value: string }[];
  body?: { data?: string; attachmentId?: string };
  parts?: MimePart[];
};

export type MimeBody = { html?: string; text?: string };

function isAttachment(part: MimePart): boolean {
  if (part.filename) return true;
  const disposition =
    part.headers?.find((h) => h.name.toLowerCase() === "content-disposition")?.value ?? "";
  return /^\s*attachment\b/i.test(disposition);
}

function hasBody(body: MimeBody): boolean {
  return body.html !== undefined || body.text !== undefined;
}

export function selectMessageBody(
  part: MimePart | undefined,
  decode: (data: string) => string,
): MimeBody {
  if (!part || isAttachment(part)) return {};
  const mime = (part.mimeType ?? "").toLowerCase();
  const data = part.body?.data;
  if (mime === "text/html") return data ? { html: decode(data) } : {};
  if (mime === "text/plain") return data ? { text: decode(data) } : {};
  if (!mime.startsWith("multipart/")) return {};

  const children = (part.parts ?? []).map((child) => selectMessageBody(child, decode));
  if (mime === "multipart/alternative") {
    // RFC 2046 §5.1.4: alternatives are ordered by increasing preference.
    const chosen: MimeBody = {};
    for (const child of children) {
      if (child.html !== undefined) chosen.html = child.html;
      if (child.text !== undefined) chosen.text = child.text;
    }
    return chosen;
  }
  return children.find(hasBody) ?? {};
}
