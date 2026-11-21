/**
 * Limits on how much message content one read may pull from a mail provider.
 * Anyone who can send mail to a connected mailbox controls how many messages a
 * conversation holds and how large each body is, so a conversation read keeps
 * only its newest messages, fetches their bodies a few at a time, and stops
 * reading any one body after a fixed number of characters.
 */

/** Characters of body content kept from one message. */
export const MAX_BODY_CHARS = 20_000;

/** Newest messages kept when a conversation is read with bodies. */
export const CONVERSATION_PAGE_SIZE = 8;

/** Body downloads in flight at once for one read. */
export const BODY_FETCH_CONCURRENCY = 4;

export type JsonReadLimits = {
  /** Longest JSON string kept, in raw (still escaped) characters. */
  maxStringChars: number;
  /** All JSON string content kept from one response, in raw characters. */
  maxTotalChars: number;
};

/** Graph `$select=body` responses carry the body as one JSON string. */
export const GRAPH_BODY_LIMITS: JsonReadLimits = {
  maxStringChars: MAX_BODY_CHARS,
  maxTotalChars: 2 * MAX_BODY_CHARS,
};

/**
 * Gmail `format=full` carries each MIME part base64url-encoded (4 characters
 * per 3 bytes) next to the headers, so the raw limits are scaled to keep about
 * MAX_BODY_CHARS of decoded text per part.
 */
export const GMAIL_BODY_LIMITS: JsonReadLimits = {
  maxStringChars: Math.ceil((MAX_BODY_CHARS * 4) / 3),
  maxTotalChars: 4 * MAX_BODY_CHARS,
};

/** Run `fn` over `items` with at most `size` calls in flight, keeping order. */
export async function mapInBatches<T, R>(
  items: readonly T[],
  size: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const out: R[] = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(...(await Promise.all(items.slice(i, i + size).map(fn))));
  }
  return out;
}

/**
 * Incremental JSON scanner that tracks string and container state so the
 * text read so far can be closed into a valid document once a string limit is
 * reached, without reading the rest of the response.
 */
class CappedJsonScanner {
  private text = "";
  private closers: string[] = [];
  private inString = false;
  private stringIsKey = false;
  private expectKey = false;
  /** -1 right after a backslash, n > 0 while n hex digits of \uXXXX remain. */
  private escape = 0;
  private stringChars = 0;
  private totalChars = 0;

  constructor(private readonly limits: JsonReadLimits) {}

  /** Feed decoded text; returns true once a limit is reached and reading must stop. */
  push(chunk: string): boolean {
    for (let i = 0; i < chunk.length; i++) {
      const ch = chunk[i];
      if (this.inString) {
        if (this.escape === -1) {
          this.escape = ch === "u" ? 4 : 0;
        } else if (this.escape > 0) {
          this.escape--;
        } else if (ch === "\\") {
          this.escape = -1;
        } else if (ch === '"') {
          this.inString = false;
          continue;
        }
        this.stringChars++;
        this.totalChars++;
        if (
          this.escape === 0 &&
          (this.stringChars >= this.limits.maxStringChars ||
            this.totalChars >= this.limits.maxTotalChars)
        ) {
          this.text += chunk.slice(0, i + 1);
          this.close();
          return true;
        }
        continue;
      }
      switch (ch) {
        case '"':
          this.inString = true;
          this.stringIsKey = this.expectKey;
          this.stringChars = 0;
          break;
        case "{":
          this.closers.push("}");
          this.expectKey = true;
          break;
        case "[":
          this.closers.push("]");
          this.expectKey = false;
          break;
        case "}":
        case "]":
          this.closers.pop();
          this.expectKey = false;
          break;
        case ":":
          this.expectKey = false;
          break;
        case ",":
          this.expectKey = this.closers[this.closers.length - 1] === "}";
          break;
      }
    }
    this.text += chunk;
    return false;
  }

  private close(): void {
    this.text += this.stringIsKey ? '":null' : '"';
    this.text += this.closers.reverse().join("");
    this.closers = [];
  }

  result(): string {
    return this.text;
  }
}

/**
 * Parse a JSON response while reading at most `limits` of string content.
 * A string that reaches a limit is cut there, the document is closed, and the
 * rest of the body is never read. Fields after the cut are absent.
 */
export async function readCappedJson(
  res: Response,
  limits: JsonReadLimits,
): Promise<unknown> {
  const scanner = new CappedJsonScanner(limits);
  if (!res.body) {
    scanner.push(await res.text());
  } else {
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        const chunk = done ? decoder.decode() : decoder.decode(value, { stream: true });
        if (scanner.push(chunk)) {
          await reader.cancel().catch(() => {});
          break;
        }
        if (done) break;
      }
    } finally {
      reader.releaseLock();
    }
  }
  const text = scanner.result();
  return text.trim() ? (JSON.parse(text) as unknown) : null;
}
