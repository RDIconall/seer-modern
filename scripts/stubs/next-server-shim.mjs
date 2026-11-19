/**
 * Re-exports Next's server helpers, except `after`.
 *
 * Outside a Next request, the real `after` throws and never runs the
 * callback. In production the callback is waited on before the invocation
 * ends (`waitUntil`), so it still spends the request budget. Record the
 * task and let the test await it.
 */
export {
  NextRequest,
  NextResponse,
  ImageResponse,
  userAgentFromString,
  userAgent,
  URLPattern,
  connection,
  unstable_rootParams,
} from "next/server";

export function after(task) {
  const run = typeof task === "function" ? task() : task;
  const promise = Promise.resolve(run);
  const list = (globalThis.__seerHtmlOnlyAfterTasks ??= []);
  list.push(promise);
}
