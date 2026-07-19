import { Suspense } from "react";
import { auth } from "@/auth";
import {
  DesktopLoginScreen,
  SessionExpiredScreen,
} from "@/components/auth/AuthScreens";
import { DesktopMailApp } from "@/components/inbox/DesktopMailApp";

export default async function DesktopHome() {
  const session = await auth();

  if (session?.user && session.error && !session.accessToken) {
    return <SessionExpiredScreen />;
  }

  if (!session?.user) {
    return <DesktopLoginScreen />;
  }

  return (
    <Suspense
      fallback={
        <p className="p-8 text-center text-sm text-[var(--muted)]">Loading…</p>
      }
    >
      <DesktopMailApp />
    </Suspense>
  );
}
