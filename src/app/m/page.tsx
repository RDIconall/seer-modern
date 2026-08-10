import { Suspense } from "react";
import { auth } from "@/auth";
import {
  MobileLoginScreen,
  SessionExpiredScreen,
} from "@/components/auth/AuthScreens";
import { MobileMailApp } from "@/components/inbox/MobileMailApp";
import { MailApp } from "@/components/v2/MailApp";
import { isV2Enabled } from "@/lib/v2/session";

export default async function MobileHome() {
  const session = await auth();

  if (session?.user && session.error && !session.accessToken) {
    return <SessionExpiredScreen mobile />;
  }

  if (!session?.user) {
    return <MobileLoginScreen />;
  }

  // Same responsive v2 app for allowlisted accounts; layout differs by CSS.
  if (isV2Enabled(session.user.email)) {
    return <MailApp />;
  }

  return (
    <Suspense
      fallback={
        <p className="p-8 text-center text-[14px] text-[var(--muted)]">Loading…</p>
      }
    >
      <MobileMailApp />
    </Suspense>
  );
}
