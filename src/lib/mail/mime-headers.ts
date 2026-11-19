/**
 * Header lines for raw RFC 5322 messages. Values here routinely come from
 * mail someone else wrote (a thread's subject, its From and Cc), so a CR or
 * LF inside one must never reach the output: it would end the line and start
 * a header — a Bcc, say — the sender never chose.
 */

const CONTROL_CHARS = /[\u0000-\u001f\u007f]+/g;
const HAS_CONTROL = /[\u0000-\u001f\u007f]/;
const ADDR_SPEC = /^[^\s<>@,;:"()[\]\\]+@[^\s<>@,;:"()[\]\\]+$/;
const NON_PRINTABLE_ASCII = /[^\x20-\x7e]/;
const MSG_ID = /<[^<>\s]+>/g;
const MIME_TYPE = /^[\w.+-]+\/[\w.+-]+$/;

/** One bare addr-spec (`local@domain`) and nothing else. */
export function isMailboxAddress(value: string): boolean {
  return !HAS_CONTROL.test(value) && ADDR_SPEC.test(value);
}

/**
 * Split an address-list header value into addr-specs. Commas or semicolons
 * inside a quoted display name or angle brackets do not split, and a
 * `Name <addr>` entry yields `addr`. Entries are not validated here.
 */
export function splitAddressList(raw: string): string[] {
  const entries: string[] = [];
  let current = "";
  let quoted = false;
  let angled = false;
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (quoted) {
      current += ch;
      if (ch === "\\" && i + 1 < raw.length) current += raw[++i];
      else if (ch === '"') quoted = false;
      continue;
    }
    if (ch === '"') quoted = true;
    else if (ch === "<") angled = true;
    else if (ch === ">") angled = false;
    else if ((ch === "," || ch === ";") && !angled) {
      entries.push(current);
      current = "";
      continue;
    }
    current += ch;
  }
  entries.push(current);
  return entries
    .map((entry) => {
      const angle = /<([^<>]*)>\s*$/.exec(entry);
      return (angle ? angle[1] : entry).trim();
    })
    .filter(Boolean);
}

/**
 * `To: a@x, b@y`. Every entry must be exactly one address; anything else is
 * refused rather than repaired, because a repaired value could still name a
 * recipient nobody saw.
 */
export function addressHeader(name: "To" | "Cc", addresses: readonly string[]): string {
  const clean = addresses.map((address) => {
    const value = address.trim();
    if (!isMailboxAddress(value)) {
      throw new Error(`invalid recipient address ${JSON.stringify(address)}`);
    }
    return value;
  });
  if (clean.length === 0) throw new Error(`${name} has no recipient`);
  return `${name}: ${clean.join(", ")}`;
}

/** Header text with every control character (CR and LF included) folded to a space. */
export function headerText(value: string): string {
  return value.replace(CONTROL_CHARS, " ").replace(/ {2,}/g, " ").trim();
}

/**
 * An unstructured header value (Subject), control characters removed and
 * non-ASCII text carried as RFC 2047 UTF-8 encoded-words on one line.
 */
export function encodedHeaderText(value: string): string {
  const text = headerText(value);
  if (!NON_PRINTABLE_ASCII.test(text)) return text;
  // 45 bytes -> 60 base64 chars, so each encoded-word stays within 75 chars.
  const words: string[] = [];
  let chunk = "";
  for (const ch of text) {
    if (Buffer.byteLength(chunk + ch, "utf8") > 45) {
      words.push(chunk);
      chunk = "";
    }
    chunk += ch;
  }
  if (chunk) words.push(chunk);
  return words
    .map((word) => `=?UTF-8?B?${Buffer.from(word, "utf8").toString("base64")}?=`)
    .join(" ");
}

/** In-Reply-To / References: only well-formed `<id>` tokens survive. */
export function messageIdList(value: string): string {
  return (value.match(MSG_ID) ?? []).filter((id) => !HAS_CONTROL.test(id)).join(" ");
}

export function attachmentMimeType(value: string | undefined): string {
  return value && MIME_TYPE.test(value) ? value : "application/octet-stream";
}
