/**
 * Postgres reports a relation or column the current database has not migrated
 * yet as 42P01 / 42703. Atlas treats those as "this additive surface is off",
 * never as a hard failure of the mailbox.
 */
export function isMissingRelation(error: unknown): boolean {
  const code =
    error && typeof error === "object" && "code" in error
      ? String((error as { code?: unknown }).code)
      : "";
  if (code === "42P01" || code === "42703") return true;
  const message = error instanceof Error ? error.message : String(error ?? "");
  return (
    /does not exist/i.test(message) &&
    /(relation|table|column|whiteboard_|bot_tasks)/i.test(message)
  );
}
