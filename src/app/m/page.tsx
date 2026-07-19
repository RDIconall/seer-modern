import { Suspense } from "react";
import { auth } from "@/auth";
import {
  MobileLoginScreen,
  SessionExpiredScreen,
} from "@/components/auth/AuthScreens";
import { MobileMailApp } from "@/components/inbox/MobileMailApp";

export default async function MobileHome() {
  const session = await auth();

  if (session?.user && session.error && !session.accessToken) {
    return <SessionExpiredScreen mobile />;
  }

  if (!session?.user) {
    return <MobileLoginScreen />;
  }

  return (
    <Suspense
      fallback={
        <p className="p-8 text-center text-sm text-[var(--muted)]">Loading…</p>
      }
    >
      <MobileMailApp />
    </Suspense>
  );
}
