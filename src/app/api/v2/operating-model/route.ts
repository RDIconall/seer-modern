import { NextResponse } from "next/server";
import { getActiveV2Account } from "@/lib/v2/session";
import { providerFor } from "@/lib/v2/providers/provider";
import { originAllowed } from "@/lib/security/origin";
import {
  loadOperatingModel,
  proposeOperatingModel,
} from "@/lib/v2/intelligence/operating-model";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

function requestOriginAllowed(request: Request): boolean {
  return originAllowed({
    origin: request.headers.get("origin"),
    requestOrigin: new URL(request.url).origin,
    allowedOrigin: process.env.SEER_ALLOWED_ORIGIN,
    production: process.env.NODE_ENV === "production",
  });
}

export async function GET() {
  const account = await getActiveV2Account();
  if (!account) {
    return NextResponse.json({ error: "no active account" }, { status: 404 });
  }
  const model = await loadOperatingModel(account.id);
  return NextResponse.json(model);
}

export async function POST(request: Request) {
  if (!requestOriginAllowed(request)) {
    return NextResponse.json({ error: "invalid request origin" }, { status: 403 });
  }
  const account = await getActiveV2Account();
  if (!account) {
    return NextResponse.json({ error: "no active account" }, { status: 404 });
  }

  let body: { action?: string; note?: string };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }
  if (body.action !== "propose") {
    return NextResponse.json({ error: "unknown action" }, { status: 400 });
  }

  let provider;
  try {
    provider = await providerFor(account);
  } catch {
    provider = undefined;
  }

  try {
    const { state, corpus } = await proposeOperatingModel(
      account.id,
      account.email,
      { provider, note: body.note },
    );
    return NextResponse.json({
      ...state,
      counts: corpus.counts,
      salesforce: {
        opportunities: corpus.salesforce.opportunities,
        studies: corpus.salesforce.studies,
      },
    });
  } catch (cause) {
    return NextResponse.json(
      {
        error:
          cause instanceof Error
            ? cause.message
            : "Could not propose Atlas sections",
      },
      { status: 502 },
    );
  }
}
