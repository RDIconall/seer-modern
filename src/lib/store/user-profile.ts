import { accountKey, kvDelete, kvGet, kvSet } from "@/lib/store/kv";

/**
 * The user's "about me" memory — a plain-text profile (role, family,
 * companies, priorities, VIPs) that Seer injects into every Gemini call
 * so triage and drafting decisions are made AS this specific person.
 *
 * Stored per account on disk, like every other Seer memory
 * (decisions, action memory, personal context). One document, always
 * current — saving replaces, it never accumulates stale fragments.
 */

export type UserProfile = {
  text: string;
  updatedAt: string;
  /** Where the text came from, for the settings UI. */
  source: "paste" | "google-doc";
  sourceUrl?: string;
};

/**
 * Hard cap for what we PERSIST. Prompt injection trims further —
 * see profilePromptBlock.
 */
export const PROFILE_MAX_CHARS = 8000;

/** What actually rides along on every triage call (token budget). */
const PROMPT_BLOCK_CHARS = 1600;

function keyFor(accountEmail: string) {
  return `profile:${accountKey(accountEmail)}`;
}

export async function loadUserProfile(
  accountEmail: string,
): Promise<UserProfile | null> {
  const parsed = await kvGet<UserProfile>(keyFor(accountEmail));
  if (parsed?.text?.trim()) return parsed;

  // Durable fallback: on serverless, .data lives in /tmp and evaporates
  // between instances. SEER_USER_PROFILE (Vercel env var) survives.
  // Set SEER_USER_PROFILE_UPDATED_AT (ISO date) when changing it to give
  // the inbox one fresh Gemini pass with the new context.
  const envText = process.env.SEER_USER_PROFILE?.trim();
  if (envText) {
    return {
      text: envText.slice(0, PROFILE_MAX_CHARS),
      updatedAt:
        process.env.SEER_USER_PROFILE_UPDATED_AT?.trim() ||
        "2000-01-01T00:00:00.000Z",
      source: "paste",
    };
  }
  return null;
}

export async function saveUserProfile(
  accountEmail: string,
  profile: Omit<UserProfile, "updatedAt">,
): Promise<UserProfile> {
  const saved: UserProfile = {
    ...profile,
    text: profile.text.slice(0, PROFILE_MAX_CHARS).trim(),
    updatedAt: new Date().toISOString(),
  };
  await kvSet(keyFor(accountEmail), saved);
  return saved;
}

export async function clearUserProfile(accountEmail: string): Promise<void> {
  await kvDelete(keyFor(accountEmail));
}

/**
 * The block appended to Gemini prompts. Kept stable between edits so
 * Gemini's implicit prompt caching still hits: static system prompt is
 * the shared prefix, this per-user block is byte-identical call to call
 * until the user edits their profile.
 */
export function profilePromptBlock(
  profile: UserProfile | null | undefined,
): string | null {
  const text = profile?.text?.trim();
  if (!text) return null;
  const trimmed =
    text.length > PROMPT_BLOCK_CHARS
      ? `${text.slice(0, PROMPT_BLOCK_CHARS)}…`
      : text;
  return `ABOUT THE USER (their own words — use to judge who matters and what is urgent for THEM):\n${trimmed}`;
}
