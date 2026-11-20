/**
 * Bounded pre-order walk over a Gmail MIME part tree.
 *
 * The tree comes from whoever sent the message, so it can be nested or
 * fanned out arbitrarily. The walk is iterative (no call-stack growth),
 * stops descending past MAX_MIME_DEPTH, and visits at most MAX_MIME_PARTS
 * parts. Parts beyond either limit are skipped; everything within them is
 * still visited in document order.
 */

/** Far deeper than any real forward chain, far below any engine's stack. */
export const MAX_MIME_DEPTH = 64;
export const MAX_MIME_PARTS = 2_000;

type MimeNode<P> = { parts?: P[] };

export function forEachMimePart<P extends MimeNode<P>>(
  root: P | undefined,
  visit: (part: P) => void,
): void {
  if (!root || typeof root !== "object") return;
  const stack: { part: P; depth: number }[] = [{ part: root, depth: 0 }];
  let visited = 0;
  while (stack.length > 0 && visited < MAX_MIME_PARTS) {
    const { part, depth } = stack.pop()!;
    visited++;
    visit(part);
    const children = part.parts;
    if (!Array.isArray(children) || depth >= MAX_MIME_DEPTH) continue;
    // Never queue more than the remaining budget, so a part with a huge
    // child list cannot balloon the stack either.
    const room = MAX_MIME_PARTS - visited - stack.length;
    const take = Math.min(children.length, Math.max(0, room));
    for (let i = take - 1; i >= 0; i--) {
      const child = children[i];
      if (child && typeof child === "object") {
        stack.push({ part: child, depth: depth + 1 });
      }
    }
  }
}
