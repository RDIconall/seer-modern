import { requireMailSession } from "@/lib/mail/session";
import { clearEa, loadEa, saveEa } from "@/lib/store/ea";
import { NextResponse } from "next/server";

/** The user's EA — the address "Delegate" forwards to. */

export async function GET() {
  try {
    const session = await requireMailSession();
    if (!session) {
      return NextResponse.json({ error: "Not signed in" }, { status: 401 });
    }
    const ea = await loadEa(session.email);
    return NextResponse.json({ ea });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Failed to load EA";
    return NextResponse.json({ error: msg }, { status: 502 });
  }
}

export async function POST(request: Request) {
  try {
    const session = await requireMailSession();
    if (!session) {
      return NextResponse.json({ error: "Not signed in" }, { status: 401 });
    }

    const body = (await request.json()) as {
      email?: string;
      name?: string;
      clear?: boolean;
    };

    if (body.clear) {
      await clearEa(session.email);
      return NextResponse.json({ ea: null });
    }

    const email = body.email?.trim() ?? "";
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return NextResponse.json(
        { error: "That doesn't look like an email address" },
        { status: 400 },
      );
    }

    const ea = await saveEa(session.email, { email, name: body.name });
    return NextResponse.json({ ea });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Failed to save EA";
    return NextResponse.json({ error: msg }, { status: 502 });
  }
}
