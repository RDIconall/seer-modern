import { auth } from "@/auth";
import {
  listAccounts,
  providerLabel,
  removeAccount,
  resolveActiveAccount,
  setActiveAccountId,
  type MailProvider,
} from "@/lib/store/accounts";
import { NextResponse } from "next/server";

function providersAvailable() {
  return {
    google: Boolean(process.env.AUTH_GOOGLE_ID && process.env.AUTH_GOOGLE_SECRET),
    microsoft: Boolean(
      process.env.AUTH_MICROSOFT_ENTRA_ID_ID &&
        process.env.AUTH_MICROSOFT_ENTRA_ID_SECRET,
    ),
  };
}

export async function GET() {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  }

  const active = await resolveActiveAccount({
    provider: session.provider,
    email: session.user.email,
    name: session.user.name,
    accessToken: session.accessToken,
  });

  const accounts = await listAccounts();
  const available = providersAvailable();

  return NextResponse.json({
    active: active
      ? {
          id: active.id,
          email: active.email,
          name: active.name,
          provider: active.provider,
          label: providerLabel(active.provider),
        }
      : session.user.email
        ? {
            id: `session:${session.user.email}`,
            email: session.user.email,
            name: session.user.name ?? session.user.email,
            provider: (session.provider as MailProvider) ?? "google",
            label: session.provider
              ? providerLabel(session.provider as MailProvider)
              : "Account",
          }
        : null,
    accounts: accounts.map((a) => ({
      ...a,
      label: providerLabel(a.provider),
      active: active?.id === a.id,
    })),
    available,
    sessionError: session.error ?? null,
  });
}

export async function POST(request: Request) {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  }

  const body = (await request.json()) as {
    action?: "switch" | "remove";
    id?: string;
  };

  if (!body.id) {
    return NextResponse.json({ error: "id required" }, { status: 400 });
  }

  if (body.action === "remove") {
    await removeAccount(body.id);
    return NextResponse.json({ ok: true });
  }

  if (body.action === "switch") {
    await setActiveAccountId(body.id);
    return NextResponse.json({ ok: true });
  }

  return NextResponse.json({ error: "Unknown action" }, { status: 400 });
}
