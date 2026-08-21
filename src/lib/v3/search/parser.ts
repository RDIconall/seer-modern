export type MailSearch = {
  text: string;
  from?: string;
  to?: string;
  subject?: string;
  label?: string;
  after?: string;
  before?: string;
  hasAttachment?: boolean;
  isUnread?: boolean;
};

const OPERATORS = new Set([
  "from",
  "to",
  "subject",
  "label",
  "after",
  "before",
  "has",
  "is",
]);

function unquote(value: string): string {
  return value.startsWith('"') && value.endsWith('"')
    ? value.slice(1, -1)
    : value;
}

/** Parse Gmail-style operators while retaining unknown/malformed terms as text. */
export function parseMailSearch(input: string): MailSearch {
  const result: MailSearch = { text: "" };
  const text: string[] = [];
  const tokens = input.match(/[^\s"]+:"[^"]*"|"[^"]*"|\S+/g) ?? [];

  for (const token of tokens) {
    const separator = token.indexOf(":");
    if (separator <= 0 || separator === token.length - 1) {
      text.push(token);
      continue;
    }
    const key = token.slice(0, separator).toLowerCase();
    const value = unquote(token.slice(separator + 1));
    if (!OPERATORS.has(key) || !value) {
      text.push(token);
      continue;
    }
    if (key === "from") result.from = value;
    else if (key === "to") result.to = value;
    else if (key === "subject") result.subject = value;
    else if (key === "label") result.label = value;
    else if (key === "after") result.after = value;
    else if (key === "before") result.before = value;
    else if (key === "has" && value === "attachment") result.hasAttachment = true;
    else if (key === "is" && value === "unread") result.isUnread = true;
    else text.push(token);
  }
  result.text = text.map(unquote).join(" ");
  return result;
}

function quote(value: string): string {
  return /\s/.test(value) ? `"${value.replaceAll('"', '\\"')}"` : value;
}

export function compileGmailSearch(search: MailSearch): string {
  return [
    search.text,
    search.from && `from:${quote(search.from)}`,
    search.to && `to:${quote(search.to)}`,
    search.subject && `subject:${quote(search.subject)}`,
    search.label && `label:${quote(search.label)}`,
    search.hasAttachment && "has:attachment",
    search.isUnread && "is:unread",
    search.after && `after:${search.after}`,
    search.before && `before:${search.before}`,
  ]
    .filter(Boolean)
    .join(" ");
}

export function compileOutlookSearch(search: MailSearch): string {
  return [
    search.text,
    search.from && `from:${quote(search.from)}`,
    search.to && `to:${quote(search.to)}`,
    search.subject && `subject:${quote(search.subject)}`,
    search.hasAttachment && "hasAttachments:true",
    search.isUnread && "isRead:false",
    search.after && `received>=${search.after}`,
    search.before && `received<${search.before}`,
  ]
    .filter(Boolean)
    .join(" ");
}
