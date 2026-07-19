import { auth } from "@/auth";
import {
  DesktopLoginScreen,
  SessionExpiredScreen,
} from "@/components/auth/AuthScreens";
import { DesktopMailApp } from "@/components/inbox/DesktopMailApp";

export default async function DesktopHome() {
  const session = await auth();

  if (session?.user && session.error) {
    return <SessionExpiredScreen />;
  }

  if (!session?.user) {
    return <DesktopLoginScreen />;
  }

  return <DesktopMailApp />;
}
