"use client";

import type { FormEvent, ReactNode } from "react";
import { clearPersistedMailboxCaches } from "@/lib/v3/mailbox/cache";

/**
 * Login and reconnect forms run as server actions. The previous session's
 * mailbox lives in localStorage, which the server cannot see, so the submit
 * has to drop it here before OAuth navigates away.
 */
export function ForgetCachedInbox({ children }: { children: ReactNode }) {
  function forget(event: FormEvent) {
    if (!(event.target instanceof HTMLFormElement)) return;
    clearPersistedMailboxCaches();
  }

  return <div onSubmitCapture={forget}>{children}</div>;
}
