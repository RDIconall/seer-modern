/**
 * Shared chat-completions client. Prefers Gemini (via its OpenAI-compatible
 * endpoint, covered by Google AI Pro/Ultra cloud credits); falls back to
 * OpenAI if only OPENAI_API_KEY is set. Returns null when no key configured.
 */

export type ChatMessage = {
  role: "system" | "user" | "assistant";
  content: string;
};

type LlmConfig = {
  baseUrl: string;
  apiKey: string;
  model: string;
};

export function llmConfig(): LlmConfig | null {
  const geminiKey = process.env.GEMINI_API_KEY;
  if (geminiKey) {
    return {
      baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
      apiKey: geminiKey,
      model: process.env.GEMINI_MODEL ?? "gemini-flash-latest",
    };
  }
  const openaiKey = process.env.OPENAI_API_KEY;
  if (openaiKey) {
    return {
      baseUrl: "https://api.openai.com/v1",
      apiKey: openaiKey,
      model: process.env.OPENAI_MODEL ?? "gpt-4o-mini",
    };
  }
  return null;
}

export function llmConfigured(): boolean {
  return llmConfig() !== null;
}

/**
 * Run a JSON-mode chat completion. Returns the raw content string, or null
 * when no provider is configured. Throws on HTTP/API errors so callers can
 * decide their own fallback.
 */
export async function llmChatJson(messages: ChatMessage[]): Promise<string | null> {
  const config = llmConfig();
  if (!config) return null;

  const res = await fetch(`${config.baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: config.model,
      temperature: 0,
      response_format: { type: "json_object" },
      messages,
    }),
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`LLM error ${res.status}: ${err.slice(0, 500)}`);
  }
  const data = (await res.json()) as {
    choices?: { message?: { content?: string } }[];
  };
  return data.choices?.[0]?.message?.content ?? null;
}
