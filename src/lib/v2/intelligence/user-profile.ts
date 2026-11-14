import { db } from "../db/pool";
import type { AccountId } from "../db/types";

/**
 * The user's "about me" memory. One document per mailbox. Env
 * `SEER_USER_PROFILE` is the durable fallback so a paste in Vercel still
 * reaches the read without a Settings UI.
 */

export type UserProfile = {
  text: string;
  updatedAt: string;
  source: "paste" | "google-doc" | "env";
  sourceUrl?: string;
};

export const PROFILE_MAX_CHARS = 8000;
const PROMPT_BLOCK_CHARS = 400;

export async function loadUserProfile(
  accountId: AccountId,
): Promise<UserProfile | null> {
  try {
    const row = await db().query<{
      text: string;
      source: UserProfile["source"];
      source_url: string | null;
      updated_at: Date | string;
    }>(
      "select text, source, source_url, updated_at from seer.user_profiles where account_id = $1",
      [accountId],
    );
    const stored = row.rows[0];
    if (stored?.text?.trim()) {
      return {
        text: stored.text.slice(0, PROFILE_MAX_CHARS),
        source: stored.source,
        sourceUrl: stored.source_url ?? undefined,
        updatedAt: new Date(stored.updated_at).toISOString(),
      };
    }
  } catch (error) {
    console.error(
      "[seer:v2] user profile table unavailable:",
      error instanceof Error ? error.message : error,
    );
  }

  const envText = process.env.SEER_USER_PROFILE?.trim();
  if (envText) {
    return {
      text: envText.slice(0, PROFILE_MAX_CHARS),
      updatedAt:
        process.env.SEER_USER_PROFILE_UPDATED_AT?.trim() ||
        "2000-01-01T00:00:00.000Z",
      source: "env",
    };
  }
  return null;
}

export function profilePromptBlock(
  profile: UserProfile | null | undefined,
): string | null {
  const text = profile?.text?.trim();
  if (!text) return null;
  const trimmed =
    text.length > PROMPT_BLOCK_CHARS
      ? `${text.slice(0, PROMPT_BLOCK_CHARS)}…`
      : text;
  return `[explicit] about you (your own words): ${trimmed}`;
}
