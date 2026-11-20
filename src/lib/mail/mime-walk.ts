/**
 * Gmail returns a message's MIME tree as nested `parts` with no depth or
 * width limit, and the sender controls that shape. Walking it recursively
 * lets one message overflow the stack, so the walk is iterative and capped.
 * Real mail nests a handful of levels; parts past either cap are not visited.
 */
export const MAX_MIME_DEPTH = 64;
export const MAX_MIME_PARTS = 1000;

type MimePart<P> = { parts?: P[] };

/** Visits parts parent-first, children in order — the same order as a recursive walk. */
export function walkMimeParts<P extends MimePart<P>>(
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
    const room = MAX_MIME_PARTS - visited - stack.length;
    for (let i = Math.min(children.length, room) - 1; i >= 0; i--) {
      const child = children[i];
      if (child && typeof child === "object") stack.push({ part: child, depth: depth + 1 });
    }
  }
}
