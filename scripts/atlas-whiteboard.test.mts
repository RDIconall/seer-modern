import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { Atlas } from "../src/components/v2/Atlas.tsx";
import { sampleView } from "../src/app/dev/preview/sample.ts";
import type { StaffView } from "../src/lib/v2/staff/types.ts";
import { seedWhiteboardView, WHITEBOARD_SEED_ITEMS } from "../src/lib/v2/whiteboard/seed.ts";
import { mapBotSlugToDomain, mapMatterSectionToDomain } from "../src/lib/v2/whiteboard/domains.ts";
import { findAnchorForConversation } from "../src/lib/v2/whiteboard/anchor.ts";

assert.equal(mapMatterSectionToDomain("sales — leads"), "sales-marketing");
assert.equal(mapMatterSectionToDomain("finance (ar/ap)"), "cash-lender");
assert.equal(mapMatterSectionToDomain("operations — studies"), "ops");
assert.equal(mapMatterSectionToDomain("board"), "board");
assert.equal(mapMatterSectionToDomain("recruiting"), "company-future");
assert.equal(mapMatterSectionToDomain("Newsletters & vendor mail"), null);
assert.equal(mapBotSlugToDomain("growth"), "sales-marketing");
assert.equal(mapBotSlugToDomain("recruiter"), "company-future");
assert.equal(mapBotSlugToDomain("chief-of-staff"), null);

assert.ok(WHITEBOARD_SEED_ITEMS.length >= 70, "Oct 30 seed is the full whiteboard");
assert.ok(WHITEBOARD_SEED_ITEMS.some((row) => row.section === "due-now"));
assert.ok(WHITEBOARD_SEED_ITEMS.some((row) => row.status === "done"));

const staff: StaffView = {
  asOf: "2026-10-16T00:00:00.000Z",
  bots: [{ id: "b1", slug: "chief-of-staff", displayName: "Chief of staff" }],
  tasks: [
    {
      id: "11111111-1111-4111-8111-111111111111",
      accountId: "acct" as StaffView["tasks"][number]["accountId"],
      botId: "b1",
      botSlug: "chief-of-staff",
      botName: "Chief of staff",
      externalKey: "B01",
      title: "Log in to Divvy and pull Czarina's expenses",
      status: "waiting_on_user",
      priority: 1,
      dueAt: null,
      notes: null,
      hisWords: "login to divvy",
      currentState: "Stuck at sign-in",
      nextAction: "Pull the list after sign-in",
      source: "bot",
      createdAt: "2026-10-15T12:00:00.000Z",
      updatedAt: "2026-10-16T12:00:00.000Z",
      events: [],
      conversationId: sampleView.atlas[0]?.conversations[0]?.conversationId ?? null,
    },
    ...Array.from({ length: 40 }, (_, index) => ({
      id: `00000000-0000-4000-8000-${String(index + 2).padStart(12, "0")}`,
      accountId: "acct" as StaffView["tasks"][number]["accountId"],
      botId: "b1",
      botSlug: "chief-of-staff",
      botName: "Chief of staff",
      externalKey: `B${String(index + 2).padStart(2, "0")}`,
      title: `Open chore ${index + 2}`,
      status: "open" as const,
      priority: 50,
      dueAt: null,
      notes: null,
      hisWords: null,
      currentState: null,
      nextAction: null,
      source: "bot" as const,
      createdAt: "2026-10-15T12:00:00.000Z",
      updatedAt: "2026-10-16T12:00:00.000Z",
      events: [],
    })),
  ],
  proposals: [
    {
      id: "22222222-2222-4222-8222-222222222222",
      botId: "b1",
      botSlug: "chief-of-staff",
      botName: "Chief of staff",
      conversationId: "c1",
      providerConversationId: "pc1",
      senderEmail: "deals@shop.test",
      subject: "40% off",
      action: "delete",
      destinationId: null,
      destinationName: null,
      rationale: "Promotional blast",
      status: "pending",
      lastError: null,
      outboxId: null,
      createdAt: "2026-10-16T12:00:00.000Z",
      decidedAt: null,
    },
  ],
  generalMessages: [],
  taskMessages: [],
};

const board = renderToString(
  createElement(Atlas, {
    view: sampleView,
    staff,
    whiteboard: seedWhiteboardView(),
    onOpenConversation: () => {},
    onOpenStaffTask: () => {},
    onOpenStaffChat: () => {},
    onCreateStaffTask: () => {},
    onDecideProposal: () => {},
  } as never),
);

assert.match(board, /Due Now/);
assert.match(board, /Cash \+ Lender/);
assert.match(board, /Needs you/);
assert.match(board, /Log in to Divvy/);
assert.match(board, />Bots/);
assert.match(board, /triage proposal/);
assert.doesNotMatch(
  board,
  /Open chore 2/,
  "41 open bot tasks must not dump onto the CEO board",
);

const mail = renderToString(
  createElement(Atlas, {
    view: sampleView,
    staff,
    whiteboard: seedWhiteboardView(),
    initialLens: "mail",
    currentConversationId: sampleView.atlas[0]?.conversations[0]?.conversationId,
    onOpenConversation: () => {},
  } as never),
);
assert.match(mail, /Open latest email for/);
assert.match(mail, /wb-m-current/);
assert.match(mail, /atlas-anchor/);
assert.match(mail, /Roche/);

const bots = renderToString(
  createElement(Atlas, {
    view: sampleView,
    staff,
    whiteboard: seedWhiteboardView(),
    initialLens: "bots",
    onOpenConversation: () => {},
    onOpenStaffTask: () => {},
    onOpenStaffChat: () => {},
  } as never),
);
assert.match(bots, /Chat with Chief of staff/);
assert.match(bots, /Chief of staff/);
assert.match(bots, /Triage proposals/);
assert.doesNotMatch(
  bots,
  /Open chore 2/,
  "bot groups start collapsed so 41 rows cannot bury the desk",
);

const conversationId = sampleView.atlas[0]?.conversations[0]?.conversationId ?? "";
const anchor = findAnchorForConversation({
  conversationId,
  matters: sampleView.atlas,
  whiteboard: seedWhiteboardView(),
  staff,
});
assert.equal(anchor?.kind, "matter");
assert.equal(anchor?.lens, "mail");
assert.match(anchor?.title ?? "", /Roche/);

console.log("atlas-whiteboard: OK");
