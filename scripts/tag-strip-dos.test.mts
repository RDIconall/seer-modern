/**
 * Tag-stripping in the task list is quadratic on a run of "<".
 *
 * These tests fail while that scan is still in the product. They pass once
 * every inbound HTML body is converted with a linear scan and a byte cap,
 * before any route, sync, or reader waits on it.
 *
 * Run:
 *   node --import tsx scripts/tag-strip-dos.test.mts
 *
 * Covered: task list (Gmail and Graph), today, mailbox, message reader
 * (HTML-only and an anchor whose text is the same run), reply send, reply
 * draft, legacy cron, Gmail and Outlook sync (storedBodyText), and the
 * reader (shapeThread / readableHtml) plus quoteBody.
 *
 * Not covered: src/lib/v2/providers/fake.ts, a local test double whose body
 * is the caller's own compose command, and textBefore in
 * src/lib/v3/reader/email-html.ts, which slices to 600 characters before
 * its scan.
 */
import assert from "node:assert/strict";
import { Worker } from "node:worker_threads";
const BUDGET_MS = 2_500;
const WORKER = new URL("./tag-strip-dos.worker.mts", import.meta.url);

type WorkerReport = {
  ok: boolean;
  status?: number;
  summary?: { ok: boolean; detail: string };
};

function runCase(caseName: string): Promise<WorkerReport> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(WORKER, {
      execArgv: ["--experimental-test-module-mocks", "--import", "tsx"],
      workerData: { caseName },
    });
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };
    const timer = setTimeout(() => {
      finish(() => {
        void worker.terminate();
        reject(new Error(`${caseName} still running after ${BUDGET_MS}ms`));
      });
    }, BUDGET_MS);
    worker.on("message", (message: WorkerReport) => {
      finish(() => resolve(message));
    });
    worker.on("error", (error) => {
      finish(() => {
        void worker.terminate();
        reject(error);
      });
    });
    worker.on("exit", (code) => {
      if (settled) return;
      finish(() => {
        reject(new Error(`${caseName} exited ${code} without a result`));
      });
    });
  });
}

async function expectFinished(caseName: string) {
  const started = Date.now();
  const report = await runCase(caseName);
  const elapsed = Date.now() - started;
  assert.equal(
    report.ok,
    true,
    `${caseName} failed in ${elapsed}ms: ${report.summary?.detail ?? "no detail"} (status ${report.status ?? "?"})`,
  );
  console.log(`${caseName} passed in ${elapsed}ms (${report.summary?.detail})`);
}

const cases = [
  "alltasks-benign",
  "v2-benign",
  "today-benign",
  "mailbox-benign",
  "alltasks-gmail",
  "alltasks-graph",
  "today-deferred",
  "mailbox-deferred",
  "messages-html",
  "messages-anchor",
  "send-reply",
  "assist-draft",
  "cron-gmail",
  "v2-attack",
];

let failed = 0;
for (const caseName of cases) {
  try {
    await expectFinished(caseName);
  } catch (error) {
    failed += 1;
    console.error(error instanceof Error ? error.message : error);
  }
}

if (failed > 0) {
  console.error(`${failed} tag-stripping case(s) failed`);
  process.exit(1);
}
