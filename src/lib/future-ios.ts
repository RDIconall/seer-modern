/**
 * Reserved for a future native client (legacy Seer iOS used RestKit + cookies).
 * Import from API routes or auth when implementing a compatibility layer.
 */
export const LEGACY_SESSION_COOKIE = "__seer_session";
export const LEGACY_USER_COOKIE = "__seer_user";
export const LEGACY_ACTION_COOKIE = "__seer_action";

/** Legacy `/api/*` paths from seer-master/conf/routes — implement gradually. */
export const LEGACY_API_PREFIXES = [
  "/api/userinfo",
  "/api/accounts",
  "/api/contacts",
  "/api/tasks",
  "/api/alltasks",
  "/api/monitor",
  "/api/picture",
  "/api/ignoreList",
  "/api/notifyList",
  "/api/register",
  "/api/autoStarTasks",
  "/api/autoUnstarTasks",
  "/api/timezone",
  "/api/reminderTime",
  "/api/expiration",
  "/api/reminderDelay",
  "/api/followupDelay",
  "/api/email",
  "/api/invite",
  "/api/resend",
  "/api/archive",
  "/api/move",
  "/api/delete",
  "/api/defer",
  "/api/calendar",
  "/api/ignore",
  "/api/notATask",
  "/api/unsubscribe",
] as const;
