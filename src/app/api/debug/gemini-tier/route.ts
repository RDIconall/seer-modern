import { NextResponse } from "next/server";

/**
 * TEMPORARY diagnostic: asks Google which tier the configured
 * GEMINI_API_KEY is on. Free tier lost Pro-model access in April 2026,
 * and 429 quota violations name their tier explicitly — either way,
 * Google's own response is the proof.
 */
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  if (searchParams.get("t") !== process.env.SEER_DEBUG_TOKEN) {
    return NextResponse.json({ error: "nope" }, { status: 404 });
  }
  const key =
    process.env.GEMINI_API_KEY ?? process.env.GOOGLE_GENERATIVE_AI_API_KEY;
  if (!key) return NextResponse.json({ error: "no key configured" });

  const probe = async (model: string) => {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
      {
        method: "POST",
        headers: { "x-goog-api-key": key, "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ parts: [{ text: "Reply with the single word: ok" }] }],
          generationConfig: { maxOutputTokens: 5 },
        }),
        cache: "no-store",
      },
    );
    const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    const err = json.error as
      | { code?: number; status?: string; message?: string; details?: unknown[] }
      | undefined;
    return {
      model,
      http: res.status,
      status: err?.status ?? "OK",
      message: err?.message?.slice(0, 300),
      details: err?.details,
    };
  };

  return NextResponse.json({
    keyPrefix: key.slice(0, 10),
    flash: await probe("gemini-flash-latest"),
    pro: await probe("gemini-2.5-pro"),
  });
}
