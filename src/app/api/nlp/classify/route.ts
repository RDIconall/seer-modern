import { hybridClassifyEmailBody } from "@/lib/nlp/hybrid-classify";
import { NextResponse } from "next/server";

export const maxDuration = 60;

export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const text =
    typeof body === "object" &&
    body !== null &&
    "text" in body &&
    typeof (body as { text: unknown }).text === "string"
      ? (body as { text: string }).text
      : null;
  if (!text || text.length > 120_000) {
    return NextResponse.json(
      { error: "Provide { text: string } with text under 120k chars" },
      { status: 400 },
    );
  }

  try {
    const result = await hybridClassifyEmailBody(text);
    return NextResponse.json(result);
  } catch (e) {
    const message = e instanceof Error ? e.message : "Classification failed";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
