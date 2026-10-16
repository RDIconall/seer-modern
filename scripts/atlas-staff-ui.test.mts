import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { Atlas } from "../src/components/v2/Atlas.tsx";
import { sampleView } from "../src/app/dev/preview/sample.ts";
import type { StaffView } from "../src/lib/v2/staff/types.ts";

const root = process.cwd();
const atlasSource = await fs.readFile(
  path.join(root, "src/components/v2/Atlas.tsx"),
  "utf8",
);
const mailClientSource = await fs.readFile(
  path.join(root, "src/components/v3/MailClient.tsx"),
  "utf8",
);

assert.match(atlasSource, /StaffBoard/);
assert.doesNotMatch(atlasSource, /MatterDetail/);
assert.doesNotMatch(atlasSource, /aria-modal/);
assert.match(mailClientSource, /StaffPane/);
assert.match(mailClientSource, /useStaffView/);
assert.match(mailClientSource, /decideTriageProposal/);

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
    },
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

const html = renderToString(
  createElement(Atlas, {
    view: sampleView,
    staff,
    onOpenConversation: () => {},
    onOpenStaffTask: () => {},
    onOpenStaffChat: () => {},
    onCreateStaffTask: () => {},
    onDecideProposal: () => {},
  } as never),
);

assert.match(html, /Whiteboard/);
assert.match(html, /Delegated/);
assert.match(html, /Chief of staff/);
assert.match(html, /Log in to Divvy/);
assert.match(html, /Waiting on Conall/);
assert.match(html, /Triage proposals/);
assert.match(html, /Approve/);
assert.match(html, /Reject/);
assert.match(html, /Chat with Chief of staff/);
assert.doesNotMatch(html, /role="dialog"/);

console.log("atlas-staff-ui: OK");
