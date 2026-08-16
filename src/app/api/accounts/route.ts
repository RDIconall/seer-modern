import { auth } from "@/auth";
import {
  legacyAccountFallbackEnabled,
  listAccountsForOwner,
  providerLabel,
  resolveActiveAccount,
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
  if (!legacyAccountFallbackEnabled()) {
    return NextResponse.json(
      { error: "legacy account management is retired" },
      { status: 410 },
    );
  }

  const email = session.user.email?.toLowerCase();
  if (!email) return NextResponse.json({ error: "email required" }, { status: 400 });

  const active = await resolveActiveAccount(
    email,
    session.provider === "google" ? "google" : "microsoft-entra-id",
  );
  const accounts = await listAccountsForOwner(email);
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

export async function POST() {
  return NextResponse.json(
    { error: "legacy account switching and removal are retired" },
    { status: 410 },
  );
}
