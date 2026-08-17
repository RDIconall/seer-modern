import { Suspense } from "react";
import { auth } from "@/auth";
import {
  DesktopLoginScreen,
  SessionExpiredScreen,
} from "@/components/auth/AuthScreens";
import { DesktopMailApp } from "@/components/inbox/DesktopMailApp";
import { MailClient } from "@/components/v3/MailClient";
import { isV2Enabled } from "@/lib/v2/session";

export default async function DesktopHome() {
  const session = await auth();

  if (session?.user && session.error && !session.accessToken) {
    return <SessionExpiredScreen />;
  }

  if (!session?.user) {
    return <DesktopLoginScreen />;
  }

  // Cutover flag: allowlisted accounts get the V3 client; everyone else
  // stays on the current app until the shadow gate clears.
  if (isV2Enabled(session.user.email)) {
    return <MailClient />;
  }

  return (
    <Suspense
      fallback={
        <p className="p-8 text-center text-[14px] text-[var(--muted)]">Loading…</p>
      }
    >
      <DesktopMailApp />
    </Suspense>
  );
}
