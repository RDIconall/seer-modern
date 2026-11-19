/**
 * Remote-image blocking over sanitised message HTML.
 *
 * The sender writes this HTML, so every pass here is a single forward scan: a
 * pattern that retries from each `<img` or `url(` and looks ahead for its end
 * rescans the rest of the body once per opener, and a few hundred kilobytes of
 * unclosed openers then hold the reading pane.
 */

const TAG_END_OR_QUOTE = /[>"']/g;

/**
 * Hand every `<img>` tag in `html` to `rewrite`, finding tags in one pass.
 * Quoted attribute values are stepped over whole, so an `<img` written inside
 * one is not mistaken for a tag.
 */
function rewriteImgTags(html: string, rewrite: (tag: string) => string): string {
  const out: string[] = [];
  let copied = 0;
  let index = 0;
  while (index < html.length) {
    const open = html.indexOf("<", index);
    if (open === -1) break;
    if (html.startsWith("<!--", open)) {
      const close = html.indexOf("-->", open + 4);
      if (close === -1) break;
      index = close + 3;
      continue;
    }
    if (!/[a-zA-Z/]/.test(html.charAt(open + 1))) {
      index = open + 1;
      continue;
    }
    let end = html.length;
    let cursor = open + 1;
    for (;;) {
      TAG_END_OR_QUOTE.lastIndex = cursor;
      const hit = TAG_END_OR_QUOTE.exec(html);
      if (!hit) break;
      if (hit[0] === ">") {
        end = hit.index + 1;
        break;
      }
      const close = html.indexOf(hit[0], hit.index + 1);
      if (close === -1) break;
      cursor = close + 1;
    }
    if (/^<img\b/i.test(html.slice(open, open + 5))) {
      const tag = html.slice(open, end);
      const rewritten = rewrite(tag);
      if (rewritten !== tag) {
        out.push(html.slice(copied, open), rewritten);
        copied = end;
      }
    }
    index = end;
  }
  if (copied === 0) return html;
  out.push(html.slice(copied));
  return out.join("");
}

const REMOTE_SRC = /^(<img\b[^>]*?)(\ssrc\s*=\s*)(["'])(https?:\/\/[^"']*)\3/i;
const CSS_URL_OPEN = /url\(\s*(["']?)https?:\/\//gi;
const CSS_URL_STOP = /[)"']/g;

/**
 * Replace each `url(https://…)` with `none`. A URL runs to the first `)`,
 * `"` or `'`; that position is found once and shared by every opener before
 * it, rather than searched for again from each one.
 */
function blockCssUrls(html: string): string {
  const out: string[] = [];
  let copied = 0;
  let stop = -1;
  let closedAt = -1;
  let closedEnd = -1;
  CSS_URL_OPEN.lastIndex = 0;
  let open: RegExpExecArray | null;
  while ((open = CSS_URL_OPEN.exec(html)) !== null) {
    const urlStart = CSS_URL_OPEN.lastIndex;
    if (stop < urlStart) {
      CSS_URL_STOP.lastIndex = urlStart;
      stop = CSS_URL_STOP.exec(html)?.index ?? -1;
      if (stop === -1) break;
    }
    const quote = open[1];
    const stopChar = html[stop];
    let end = -1;
    if (!quote) {
      if (stopChar === ")") end = stop + 1;
    } else if (stopChar === quote) {
      if (closedAt !== stop) {
        let cursor = stop + 1;
        while (cursor < html.length && /\s/.test(html[cursor])) cursor += 1;
        closedAt = stop;
        closedEnd = html[cursor] === ")" ? cursor + 1 : -1;
      }
      end = closedEnd;
    }
    if (end === -1) {
      CSS_URL_OPEN.lastIndex = open.index + 1;
      continue;
    }
    out.push(html.slice(copied, open.index), "none");
    copied = end;
    CSS_URL_OPEN.lastIndex = end;
  }
  if (copied === 0) return html;
  out.push(html.slice(copied));
  return out.join("");
}

/** Block network-loaded images without disturbing embedded CID/data images. */
export function stripRemoteImages(html: string): string {
  const result = rewriteImgTags(html, (tag) =>
    tag.replace(REMOTE_SRC, "$1 data-blocked-src=$3$4$3 src=$3$3"),
  );
  return blockCssUrls(result);
}

const BLOCKED_SRC = /\sdata-blocked-src\s*=\s*(["'])(https?:\/\/[^"']*)\1/i;
const EMPTY_SRC = /\ssrc\s*=\s*(["'])\1/i;

export function restoreRemoteImages(html: string): string {
  return rewriteImgTags(html, (tag) => {
    const blocked = BLOCKED_SRC.exec(tag);
    if (!blocked || tag.lastIndexOf(">", blocked.index) !== -1) return tag;
    const afterBlocked = blocked.index + blocked[0].length;
    const empty = EMPTY_SRC.exec(tag.slice(afterBlocked));
    if (!empty) return tag;
    const emptyAt = afterBlocked + empty.index;
    if (tag.slice(afterBlocked, emptyAt).includes(">")) return tag;
    const [, quote, url] = blocked;
    return (
      tag.slice(0, blocked.index) +
      ` src=${quote}${url}${quote}` +
      tag.slice(afterBlocked, emptyAt) +
      tag.slice(emptyAt + empty[0].length)
    );
  });
}

export function hasRemoteImages(html: string): boolean {
  return /data-blocked-src\s*=\s*["']https?:\/\//i.test(html);
}
