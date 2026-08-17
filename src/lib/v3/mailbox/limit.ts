const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

export function parseMailboxLimit(raw: string | null, defaultLimit = DEFAULT_LIMIT): number {
  if (raw === null || raw.trim() === "") return defaultLimit;
  const n = Number(raw);
  if (!Number.isFinite(n)) return defaultLimit;
  return Math.max(1, Math.min(MAX_LIMIT, Math.trunc(n)));
}
