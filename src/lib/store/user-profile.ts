import { promises as fs } from "fs";
import path from "path";

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

const DATA_DIR =
  process.env.SEER_DATA_DIR || path.join(process.cwd(), ".data");

/**
 * Hard cap for what we PERSIST. Prompt injection trims further —
 * see profilePromptBlock.
 */
export const PROFILE_MAX_CHARS = 8000;

/** What actually rides along on every triage call (token budget). */
const PROMPT_BLOCK_CHARS = 1600;

function fileFor(accountEmail: string) {
  const safe = accountEmail.toLowerCase().replace(/[^a-z0-9@._-]/g, "_");
  return path.join(DATA_DIR, `profile-${safe}.json`);
}

export async function loadUserProfile(
  accountEmail: string,
): Promise<UserProfile | null> {
  try {
    const raw = await fs.readFile(fileFor(accountEmail), "utf8");
    const parsed = JSON.parse(raw) as UserProfile;
    return parsed.text?.trim() ? parsed : null;
  } catch {
    return null;
  }
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
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.writeFile(fileFor(accountEmail), JSON.stringify(saved), "utf8");
  return saved;
}

export async function clearUserProfile(accountEmail: string): Promise<void> {
  await fs.unlink(fileFor(accountEmail)).catch(() => {});
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
