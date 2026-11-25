/**
 * RFC 5322 address-list parsing for raw From / To / Cc header values.
 *
 * Quoted strings and comments are opaque: a comma, angle bracket, or address
 * inside them never starts a mailbox or becomes the mailbox address. The
 * address of a name-addr mailbox comes only from its angle-addr.
 */

export type ParsedMailbox = { name?: string; email: string };

type Token =
  | { kind: "atom"; value: string }
  | { kind: "quoted"; value: string }
  | { kind: "angle"; value: string }
  | { kind: "comma" }
  | { kind: "colon" }
  | { kind: "semicolon" };

const SPECIAL = new Set(['"', "(", ")", "<", ">", ",", ":", ";"]);
const ADDR_SPEC = /^[^\s@<>()",;:\\]+@[^\s@<>()",;:\\]+$/;
const QUOTED_LOCAL_ADDR_SPEC = /^"(?:[^"\\]|\\.)*"@[^\s@<>()",;:\\]+$/;

function isWhitespace(ch: string): boolean {
  return ch === " " || ch === "\t" || ch === "\r" || ch === "\n";
}

/** Returns null when a quote, comment, or angle-addr is never closed. */
function tokenize(raw: string): Token[] | null {
  const tokens: Token[] = [];
  let i = 0;
  while (i < raw.length) {
    const ch = raw[i];
    if (isWhitespace(ch)) {
      i++;
    } else if (ch === '"') {
      let value = "";
      i++;
      let closed = false;
      while (i < raw.length) {
        const c = raw[i];
        if (c === "\\" && i + 1 < raw.length) {
          value += raw[i + 1];
          i += 2;
        } else if (c === '"') {
          closed = true;
          i++;
          break;
        } else {
          value += c;
          i++;
        }
      }
      if (!closed) return null;
      tokens.push({ kind: "quoted", value });
    } else if (ch === "(") {
      let depth = 1;
      i++;
      while (i < raw.length && depth > 0) {
        const c = raw[i];
        if (c === "\\" && i + 1 < raw.length) i += 2;
        else {
          if (c === "(") depth++;
          else if (c === ")") depth--;
          i++;
        }
      }
      if (depth !== 0) return null;
    } else if (ch === "<") {
      let value = "";
      i++;
      let closed = false;
      let inQuote = false;
      while (i < raw.length) {
        const c = raw[i];
        if (inQuote && c === "\\" && i + 1 < raw.length) {
          value += c + raw[i + 1];
          i += 2;
          continue;
        }
        if (c === '"') inQuote = !inQuote;
        else if (!inQuote && c === "<") return null;
        else if (!inQuote && c === ">") {
          closed = true;
          i++;
          break;
        }
        value += c;
        i++;
      }
      if (!closed) return null;
      tokens.push({ kind: "angle", value });
    } else if (ch === ",") {
      tokens.push({ kind: "comma" });
      i++;
    } else if (ch === ":") {
      tokens.push({ kind: "colon" });
      i++;
    } else if (ch === ";") {
      tokens.push({ kind: "semicolon" });
      i++;
    } else if (ch === ")" || ch === ">") {
      return null;
    } else {
      let value = "";
      while (i < raw.length && !isWhitespace(raw[i]) && !SPECIAL.has(raw[i])) {
        value += raw[i];
        i++;
      }
      tokens.push({ kind: "atom", value });
    }
  }
  return tokens;
}

function validAddrSpec(value: string): string | null {
  const email = value.trim();
  return ADDR_SPEC.test(email) || QUOTED_LOCAL_ADDR_SPEC.test(email) ? email : null;
}

/** One mailbox from its tokens, or null when it is not a valid mailbox. */
function toMailbox(tokens: Token[]): ParsedMailbox | null {
  if (tokens.length === 0) return null;
  const angles = tokens.filter((t) => t.kind === "angle");
  if (angles.length > 1) return null;
  if (angles.length === 1) {
    const last = tokens[tokens.length - 1];
    if (last.kind !== "angle") return null;
    // obs-route: <@relay.example:user@example.com>
    const route = last.value.lastIndexOf(":");
    const spec = route >= 0 && last.value.trimStart().startsWith("@")
      ? last.value.slice(route + 1)
      : last.value;
    const email = validAddrSpec(spec);
    if (!email) return null;
    const words = tokens
      .slice(0, -1)
      .map((t) => (t.kind === "atom" || t.kind === "quoted" ? t.value : ""));
    const name = words.join(" ").replace(/\s+/g, " ").trim();
    return name ? { name, email } : { email };
  }
  if (tokens.length !== 1 || tokens[0].kind !== "atom") return null;
  const email = validAddrSpec(tokens[0].value);
  return email ? { email } : null;
}

type ParsedList = { mailboxes: ParsedMailbox[]; invalid: number };

function parse(raw: string): ParsedList | null {
  const tokens = tokenize(raw ?? "");
  if (!tokens) return null;
  const mailboxes: ParsedMailbox[] = [];
  let invalid = 0;
  let current: Token[] = [];
  let inGroup = false;
  const flush = () => {
    if (current.length === 0) return;
    const mailbox = toMailbox(current);
    if (mailbox) mailboxes.push(mailbox);
    else invalid++;
    current = [];
  };
  for (const token of tokens) {
    if (token.kind === "comma") {
      flush();
    } else if (token.kind === "colon") {
      // group: display-name ":" [group-list] ";" — the display name is not a mailbox.
      if (inGroup) return null;
      inGroup = true;
      current = [];
    } else if (token.kind === "semicolon") {
      if (!inGroup) return null;
      flush();
      inGroup = false;
    } else {
      current.push(token);
    }
  }
  if (inGroup) return null;
  flush();
  return { mailboxes, invalid };
}

/**
 * Every valid mailbox in an address-list header (To, Cc, Bcc). Group members
 * are flattened. Entries that are not valid mailboxes are dropped, and an
 * unterminated quote, comment, or angle-addr yields no mailboxes at all.
 */
export function parseAddressList(raw: string): ParsedMailbox[] {
  return parse(raw)?.mailboxes ?? [];
}

/**
 * The single author mailbox of a From header, or null when the header does
 * not hold exactly one valid mailbox. A multi-author or malformed From has no
 * single identity to attribute the message to.
 */
export function parseSenderMailbox(raw: string): ParsedMailbox | null {
  const parsed = parse(raw);
  if (!parsed || parsed.invalid > 0 || parsed.mailboxes.length !== 1) return null;
  return parsed.mailboxes[0];
}
