/**
 * Reading a JSON body that may not be there.
 *
 * `response.json()` throws `Unexpected end of JSON input` on an empty body, and
 * an empty body is exactly what a crashed route handler, a gateway that gave
 * up, or a sign-in redirect answers with. The mail client used to put that
 * string in front of the user in place of the reason their action failed:
 * "Add to Atlas was not queued. … Failed to execute 'json' on 'Response'".
 *
 * A missing or unparsable body is therefore not an exception here. It is
 * absence, and the caller says what absence means with `describeHttpFailure`.
 */

export async function readJsonBody<T>(response: Response): Promise<T | null> {
  let text: string;
  try {
    text = await response.text();
  } catch {
    return null;
  }
  if (text.trim().length === 0) return null;
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

/**
 * What to tell the user when the server said nothing usable. The status is kept
 * in the sentence: a report of "500" is worth having when someone asks for the
 * logs, and it distinguishes a signed-out session from a server fault.
 */
export function describeHttpFailure(status: number): string {
  if (status === 401 || status === 403) {
    return `Seer is not signed in any more (${status}). Reload the page and sign in again.`;
  }
  if (status === 404) {
    return `Seer has no active mail account (${status}). Reconnect the account in Settings.`;
  }
  if (status === 429) {
    return `Seer is being rate limited (${status}). Wait a moment and try again.`;
  }
  if (status === 502 || status === 503 || status === 504) {
    return `Seer could not be reached (${status}). Check your connection and try again.`;
  }
  if (status >= 500) {
    return `Seer's server failed (${status}) without saying why. Please try again.`;
  }
  if (status >= 400) {
    return `Seer rejected the request (${status}).`;
  }
  return "Seer's server sent an empty response. Please try again.";
}
