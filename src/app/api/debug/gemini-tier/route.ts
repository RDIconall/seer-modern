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

  // Which models does Google offer THIS key? (pro visibility = tier hint)
  const listRes = await fetch(
    "https://generativelanguage.googleapis.com/v1beta/models?pageSize=100",
    { headers: { "x-goog-api-key": key }, cache: "no-store" },
  );
  const listJson = (await listRes.json().catch(() => ({}))) as {
    models?: { name: string; supportedGenerationMethods?: string[] }[];
  };
  const generatable = (listJson.models ?? [])
    .filter((m) => m.supportedGenerationMethods?.includes("generateContent"))
    .map((m) => m.name.replace("models/", ""));
  const proModels = generatable.filter((n) => /pro/i.test(n));
  const proPick =
    searchParams.get("m") ??
    (proModels.includes("gemini-pro-latest")
      ? "gemini-pro-latest"
      : (proModels[0] ?? "gemini-pro-latest"));

  return NextResponse.json({
    keyPrefix: key.slice(0, 10),
    flash: await probe("gemini-flash-latest"),
    pro: await probe(proPick),
    proModelsVisible: proModels.slice(0, 8),
    modelCount: generatable.length,
  });
}
