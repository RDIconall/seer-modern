import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { AutoTriageAudit } from "../src/components/v2/AutoTriageAudit.tsx";
import { StaffBoard } from "../src/components/v2/StaffBoard.tsx";
import type { StaffView } from "../src/lib/v2/staff/types.ts";

const root = process.cwd();
const atlasSource = await fs.readFile(
  path.join(root, "src/components/v2/Atlas.tsx"),
  "utf8",
);
assert.match(atlasSource, /AutoTriageAudit/);

const html = renderToString(
  createElement(AutoTriageAudit, {
    initial: {
      envMode: "dry_run",
      effectiveMode: "dry_run",
      settings: {
        accountId: "acct",
        mode: "dry_run",
        aiEnabled: false,
        aiAutoThreshold: 0.9,
        updatedAt: "2026-10-18T00:00:00.000Z",
      },
      groups: [
        {
          sender: "newsletter@labmanager.com",
          count: 2,
          deleteCount: 2,
          archiveCount: 0,
          keepCount: 0,
          reviewCount: 0,
          subjects: ["Weekly digest"],
          rule: "5:domain:labmanager.com",
          decider: "rule",
          latestLogId: "33333333-3333-4333-8333-333333333333",
          undone: false,
        },
      ],
    },
  }),
);

assert.match(html, /Cleaned this week/);
assert.match(html, /would have deleted/);
assert.match(html, /Undo/);
assert.match(html, /Always keep this sender/);
assert.match(html, /newsletter@labmanager.com/);

const staff: StaffView = {
  asOf: "2026-10-18T00:00:00.000Z",
  bots: [{ id: "b1", slug: "chief-of-staff", displayName: "Chief of staff" }],
  tasks: [],
  proposals: [
    {
      id: "22222222-2222-4222-8222-222222222222",
      botId: "b1",
      botSlug: "chief-of-staff",
      botName: "Chief of staff",
      conversationId: "c1",
      providerConversationId: "pc1",
      senderEmail: "dse_na2@docusign.net",
      subject: "Completed: MSA",
      action: "file",
      destinationId: null,
      destinationName: "Files to Save (save PDF to Drive first)",
      rationale: "signed agreement",
      status: "pending",
      lastError: null,
      outboxId: null,
      createdAt: "2026-10-18T00:00:00.000Z",
      decidedAt: null,
    },
  ],
  generalMessages: [],
  taskMessages: [],
};

const staffHtml = renderToString(createElement(StaffBoard, { view: staff }));
assert.match(staffHtml, /Save PDF/);

console.log("v2-autotriage-ui: OK");
