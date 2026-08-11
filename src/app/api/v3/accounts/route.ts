import { auth } from "@/auth";
import { revokeProviderGrant } from "@/lib/mail/revoke";
import {
  deleteOwnedAccount,
  getCredentials,
  getOwnedAccount,
  listOwnedAccounts,
  upsertUser,
} from "@/lib/v2/db/accounts";
import { asAccountId } from "@/lib/v2/db/types";
import {
  getActiveAccountId,
  setActiveAccountId,
} from "@/lib/store/accounts";
import { originAllowed } from "@/lib/security/origin";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

type PublicAccount = {
  id: string;
  provider: "google" | "microsoft";
  email: string;
  name: string;
  label: string;
  active: boolean;
};

function providerLabel(provider: PublicAccount["provider"]): string {
  return provider === "google" ? "Gmail" : "Outlook";
}

function publicAccount(
  account: Awaited<ReturnType<typeof listOwnedAccounts>>[number],
  activeId: string | null,
): PublicAccount {
  return {
    id: account.id,
    provider: account.provider,
    email: account.email,
    name: account.displayName ?? account.email,
    label: providerLabel(account.provider),
    active: account.id === activeId,
  };
}

async function currentUser() {
  const session = await auth();
  const email = session?.user?.email?.trim().toLowerCase();
  if (!email) return null;
  return { session, email, userId: await upsertUser(email) };
}

function providersAvailable() {
  return {
    google: Boolean(process.env.AUTH_GOOGLE_ID && process.env.AUTH_GOOGLE_SECRET),
    microsoft: Boolean(
      process.env.AUTH_MICROSOFT_ENTRA_ID_ID &&
        process.env.AUTH_MICROSOFT_ENTRA_ID_SECRET,
    ),
  };
}

function requestOriginAllowed(request: Request): boolean {
  return originAllowed({
    origin: request.headers.get("origin"),
    requestOrigin: new URL(request.url).origin,
    allowedOrigin: process.env.SEER_ALLOWED_ORIGIN,
    production: process.env.NODE_ENV === "production",
  });
}

export async function GET() {
  const current = await currentUser();
  if (!current) {
    return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  }
  const accounts = await listOwnedAccounts(current.userId);
  const activeId = await getActiveAccountId();
  const active =
    accounts.find((account) => account.id === activeId) ??
    accounts.find((account) => account.email === current.email) ??
    null;
  const effectiveActiveId = active?.id ?? null;
  return NextResponse.json({
    active: active ? publicAccount(active, effectiveActiveId) : null,
    accounts: accounts.map((account) => publicAccount(account, effectiveActiveId)),
    available: providersAvailable(),
    sessionError: current.session?.error ?? null,
  });
}

export async function POST(request: Request) {
  if (!requestOriginAllowed(request)) {
    return NextResponse.json({ error: "invalid request origin" }, { status: 403 });
  }
  const current = await currentUser();
  if (!current) {
    return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  }
  const body = (await request.json().catch(() => null)) as {
    action?: "switch" | "remove";
    id?: string;
    confirmed?: boolean;
  } | null;
  if (!body?.id || (body.action !== "switch" && body.action !== "remove")) {
    return NextResponse.json({ error: "action and id required" }, { status: 400 });
  }

  const id = asAccountId(body.id);
  const owned = await getOwnedAccount(current.userId, id);
  if (!owned) {
    return NextResponse.json({ error: "Account not found" }, { status: 404 });
  }

  if (body.action === "switch") {
    await setActiveAccountId(owned.id);
    return NextResponse.json({ ok: true, activeId: owned.id });
  }

  if (body.confirmed !== true) {
    return NextResponse.json(
      { error: "Confirmation required to remove this account" },
      { status: 400 },
    );
  }
  const requiresSignOut = (await getActiveAccountId()) === owned.id;
  const credentials = await getCredentials(owned.id);
  if (credentials) {
    await revokeProviderGrant({
      id: owned.id,
      provider: owned.provider === "google" ? "google" : "microsoft-entra-id",
      email: owned.email,
      name: owned.displayName ?? owned.email,
      accessToken: credentials.accessToken,
      refreshToken: credentials.refreshToken,
      expiresAt: credentials.expiresAt
        ? Math.floor(credentials.expiresAt / 1000)
        : undefined,
      updatedAt: new Date().toISOString(),
    });
  }
  const removed = await deleteOwnedAccount(current.userId, owned.id);
  if (!removed) {
    return NextResponse.json({ error: "Account not found" }, { status: 404 });
  }
  if (requiresSignOut) {
    await setActiveAccountId(null);
  }
  return NextResponse.json({ ok: true, requiresSignOut });
}
