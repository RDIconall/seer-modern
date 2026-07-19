import { auth } from "@/auth";
import {
  MobileLoginScreen,
  SessionExpiredScreen,
} from "@/components/auth/AuthScreens";
import { MobileMailApp } from "@/components/inbox/MobileMailApp";

export default async function MobileHome() {
  const session = await auth();

  if (session?.user && session.error) {
    return <SessionExpiredScreen mobile />;
  }

  if (!session?.user) {
    return <MobileLoginScreen />;
  }

  return <MobileMailApp />;
}
