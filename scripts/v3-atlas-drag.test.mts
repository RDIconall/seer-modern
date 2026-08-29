/**
 * Atlas drag, driven through a real DOM.
 *
 * The board's reorder maths was always unit-tested; what went wrong lived in
 * the gesture on top of it — a press that committed a drop, a drop that landed
 * one row high, a keystroke that stepped over a matter rolled out of sight, and
 * a confirmed move repainted away by the view it was still waiting on. None of
 * those are visible to a test of pure functions, so this one presses the grip.
 */
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import type { AtlasSection, InboxView, MatterCard } from "../src/lib/v2/view/types.ts";

const dom = new JSDOM("<!doctype html><html><body></body></html>", {
  pretendToBeVisual: true,
  url: "http://localhost/",
});
const { window } = dom;

class PointerEventPolyfill extends window.MouseEvent {
  readonly pointerId: number;
  constructor(type: string, init: MouseEventInit & { pointerId?: number } = {}) {
    super(type, init);
    this.pointerId = init.pointerId ?? 1;
  }
}

const globals = globalThis as unknown as Record<string, unknown>;
globals.window = window;
globals.document = window.document;
// Node 22 exposes `navigator` as a getter-only global, so it is redefined.
Object.defineProperty(globals, "navigator", {
  value: window.navigator,
  configurable: true,
});
globals.HTMLElement = window.HTMLElement;
globals.Element = window.Element;
globals.Node = window.Node;
globals.MouseEvent = window.MouseEvent;
globals.KeyboardEvent = window.KeyboardEvent;
globals.PointerEvent = PointerEventPolyfill;
globals.requestAnimationFrame = window.requestAnimationFrame.bind(window);
globals.cancelAnimationFrame = window.cancelAnimationFrame.bind(window);
globals.getComputedStyle = window.getComputedStyle.bind(window);
globals.IS_REACT_ACT_ENVIRONMENT = true;
(window as unknown as Record<string, unknown>).PointerEvent = PointerEventPolyfill;

// Imported after the DOM exists: the module reads `window` as it initialises.
const { Atlas } = await import("../src/components/v2/Atlas.tsx");

/* ------------------------------------------------------------- fixtures --- */

const conversation = (id: string, weSpokeLast: boolean) => ({
  conversationId: `${id}-c`,
  providerConversationId: `${id}-p`,
  subject: id,
  from: "Someone",
  at: new Date().toISOString(),
  summary: "",
  owner: "you",
  priority: 1,
  dueDate: null,
  category: "sales",
  counterparty: "acme",
  weSpokeLast,
  nativeUrl: "",
});

const matter = (id: string, section: string, awaitingReply = false): MatterCard =>
  ({
    matterId: id,
    title: id,
    shortTitle: id,
    status: "open",
    orgUnit: "acme",
    section,
    summary: "",
    nextAction: "",
    owner: "you",
    dueDate: null,
    conversations: [conversation(id, awaitingReply)],
    yields: [],
  }) as MatterCard;

const viewOf = (sections: AtlasSection[]): InboxView =>
  ({
    asOf: new Date().toISOString(),
    coverage: { providerTotal: 0, stored: 0, read: 0, pending: 0 },
    atlas: sections.flatMap((section) => section.matters),
    sections,
    functions: sections.map((section) => section.name),
    records: [],
    safeToDelete: [],
    undecided: [],
    worthReading: [],
  }) as InboxView;

/* ------------------------------------------------------------ harness ---- */

const ROW_HEIGHT = 36;

/** jsdom has no layout, so give the rows one: a stack of 36px lines. */
function layOutRows(container: Element) {
  const rows = [...container.querySelectorAll<HTMLElement>("[data-atlas-matter]")];
  rows.forEach((row, index) => {
    const top = index * ROW_HEIGHT;
    row.getBoundingClientRect = () =>
      ({
        top,
        bottom: top + ROW_HEIGHT,
        height: ROW_HEIGHT,
        left: 0,
        right: 300,
        width: 300,
        x: 0,
        y: top,
        toJSON: () => ({}),
      }) as DOMRect;
  });
  window.document.elementFromPoint = ((x: number, y: number) =>
    rows.find((row) => {
      const box = row.getBoundingClientRect();
      return y >= box.top && y < box.bottom;
    }) ?? null) as typeof window.document.elementFromPoint;
  return rows;
}

const order = (container: Element) =>
  [...container.querySelectorAll<HTMLElement>("[data-atlas-matter]")].map(
    (row) => row.dataset.atlasMatter,
  );

const gripOf = (container: Element, matterId: string) =>
  container.querySelector<HTMLElement>(
    `[data-atlas-matter="${matterId}"] .wb-drag`,
  )!;

function pointer(
  target: Element,
  type: string,
  clientX: number,
  clientY: number,
) {
  target.dispatchEvent(
    new PointerEventPolyfill(type, {
      bubbles: true,
      cancelable: true,
      clientX,
      clientY,
      button: 0,
      buttons: type === "pointerup" ? 0 : 1,
      pointerId: 1,
    }),
  );
}

type Mounted = {
  container: HTMLElement;
  reorders: Array<{ section: string; matterIds: string[] }>;
  moves: Array<{ matterId: string; toSection: string }>;
  setView: (next: InboxView) => void;
  unmount: () => void;
};

function mount(
  sections: AtlasSection[],
  options: { onReorder?: () => Promise<unknown> } = {},
): Mounted {
  const container = window.document.createElement("div");
  window.document.body.appendChild(container);
  const root = createRoot(container);
  const reorders: Mounted["reorders"] = [];
  const moves: Mounted["moves"] = [];
  let view = viewOf(sections);

  const render = () => {
    act(() => {
      root.render(
        createElement(Atlas, {
          view,
          onReorderMatters: (section: string, matterIds: string[]) => {
            reorders.push({ section, matterIds });
            return options.onReorder?.() ?? Promise.resolve();
          },
          onMoveMatter: (move: { matterId: string; toSection: string }) => {
            moves.push({ matterId: move.matterId, toSection: move.toSection });
            return Promise.resolve();
          },
        } as never),
      );
    });
  };

  render();
  return {
    container,
    reorders,
    moves,
    setView: (next) => {
      view = next;
      render();
    },
    unmount: () => {
      act(() => root.unmount());
      container.remove();
    },
  };
}

/** Press the grip of `matterId` and release it at `clientY`. */
function drag(board: Mounted, matterId: string, clientY: number) {
  const rows = layOutRows(board.container);
  const from = rows.findIndex((row) => row.dataset.atlasMatter === matterId);
  const startY = from * ROW_HEIGHT + ROW_HEIGHT / 2;
  const grip = gripOf(board.container, matterId);
  act(() => {
    pointer(grip, "pointerdown", 10, startY);
  });
  for (let step = 1; step <= 4; step += 1) {
    const y = startY + ((clientY - startY) * step) / 4;
    act(() => {
      pointer(grip, "pointermove", 10, y);
    });
  }
  const indicator =
    board.container
      .querySelector<HTMLElement>('[data-drop-before="true"]')
      ?.dataset.atlasMatter ??
    (board.container.querySelector('.wb-sec[data-drop-end="true"]')
      ? "END"
      : null);
  const painted = board.container.querySelector('[data-dragging="true"]') !== null;
  act(() => {
    pointer(grip, "pointerup", 10, clientY);
  });
  return { indicator, painted };
}

/* ---------------------------------------------------------------- tests --- */

const sales = (ids: string[]): AtlasSection[] => [
  { name: "sales", matters: ids.map((id) => matter(id, "sales")) },
];

// A drop lands in the gap the board pointed at. Aiming below a row used to put
// the matter above it, so every drop came down one place high.
{
  const board = mount(sales(["a", "b", "c", "d"]));
  const { indicator, painted } = drag(board, "a", ROW_HEIGHT * 2 + 30);
  assert.equal(painted, true, "the dragged row is painted as dragging");
  assert.equal(indicator, "d", "the indicator shows the gap below row c");
  assert.deepEqual(order(board.container), ["b", "c", "a", "d"]);
  assert.deepEqual(board.reorders.at(-1), {
    section: "sales",
    matterIds: ["b", "c", "a", "d"],
  });
  board.unmount();
}

// Aiming at the top half of a row puts the matter in front of it.
{
  const board = mount(sales(["a", "b", "c", "d"]));
  const { indicator } = drag(board, "d", ROW_HEIGHT + 6);
  assert.equal(indicator, "b");
  assert.deepEqual(order(board.container), ["a", "d", "b", "c"]);
  board.unmount();
}

// Past the last row, a drop appends rather than doing nothing.
{
  const board = mount(sales(["a", "b", "c"]));
  const { indicator } = drag(board, "a", ROW_HEIGHT * 2 + 30);
  assert.equal(indicator, "END");
  assert.deepEqual(order(board.container), ["b", "c", "a"]);
  board.unmount();
}

// A press that never travels is a press. It used to commit a drop wherever the
// finger happened to lift.
{
  const board = mount(sales(["a", "b", "c"]));
  layOutRows(board.container);
  const grip = gripOf(board.container, "a");
  act(() => {
    pointer(grip, "pointerdown", 10, 18);
  });
  act(() => {
    pointer(grip, "pointermove", 11, 19);
  });
  act(() => {
    pointer(grip, "pointerup", 11, 19);
  });
  assert.deepEqual(order(board.container), ["a", "b", "c"]);
  assert.deepEqual(board.reorders, [], "a tap queues no command");
  board.unmount();
}

// A gesture the browser takes over mid-drag leaves the board as it was.
{
  const board = mount(sales(["a", "b", "c"]));
  layOutRows(board.container);
  const grip = gripOf(board.container, "a");
  act(() => {
    pointer(grip, "pointerdown", 10, 18);
  });
  act(() => {
    pointer(grip, "pointermove", 10, 90);
  });
  act(() => {
    grip.dispatchEvent(new PointerEventPolyfill("pointercancel", { bubbles: true }));
  });
  assert.equal(
    board.container.querySelector('[data-drop-before="true"]'),
    null,
    "a cancelled drag clears its indicator",
  );
  act(() => {
    pointer(grip, "pointerup", 10, 90);
  });
  assert.deepEqual(order(board.container), ["a", "b", "c"]);
  assert.deepEqual(board.reorders, []);
  board.unmount();
}

// Arrow keys move a matter, and they step over what the user can see. A section
// also carries outreach rolled out of sight, and stepping over one of those
// moved the matter past a row that was not on screen — which reads as the key
// having done nothing at all.
{
  const board = mount([
    {
      name: "sales",
      matters: [
        matter("a", "sales"),
        matter("hidden", "sales", true),
        matter("b", "sales"),
        matter("c", "sales"),
      ],
    },
  ]);
  assert.deepEqual(
    order(board.container),
    ["a", "b", "c"],
    "outreach awaiting a reply is rolled up, not listed",
  );
  const grip = gripOf(board.container, "b");
  act(() => {
    grip.dispatchEvent(
      new window.KeyboardEvent("keydown", {
        key: "ArrowUp",
        bubbles: true,
        cancelable: true,
      }),
    );
  });
  assert.deepEqual(
    order(board.container),
    ["b", "a", "c"],
    "ArrowUp swaps with the row above the one on screen",
  );
  act(() => {
    gripOf(board.container, "b").dispatchEvent(
      new window.KeyboardEvent("keydown", {
        key: "ArrowDown",
        bubbles: true,
        cancelable: true,
      }),
    );
  });
  assert.deepEqual(order(board.container), ["a", "b", "c"]);
  board.unmount();
}

// The first row cannot climb and the last cannot fall, and neither sends a
// command for a move that did not happen.
{
  const board = mount(sales(["a", "b"]));
  act(() => {
    gripOf(board.container, "a").dispatchEvent(
      new window.KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true }),
    );
  });
  assert.deepEqual(order(board.container), ["a", "b"]);
  assert.deepEqual(board.reorders, []);
  board.unmount();
}

// A drop is confirmed by the server, and until the confirmation lands the view
// still describes the old order. Repainting from it is what snapped a dragged
// matter back to where it started.
{
  let release: () => void = () => {};
  const board = mount(sales(["a", "b", "c"]), {
    onReorder: () =>
      new Promise<void>((resolve) => {
        release = resolve;
      }),
  });
  drag(board, "a", ROW_HEIGHT * 2 + 30);
  assert.deepEqual(order(board.container), ["b", "c", "a"]);

  // The stale view arrives while the command is still in flight.
  board.setView(viewOf(sales(["a", "b", "c"])));
  assert.deepEqual(
    order(board.container),
    ["b", "c", "a"],
    "an unconfirmed move survives a stale view",
  );

  await act(async () => {
    release();
  });
  board.setView(viewOf(sales(["b", "c", "a"])));
  assert.deepEqual(order(board.container), ["b", "c", "a"]);
  board.unmount();
}

console.log("v3-atlas-drag: OK");
