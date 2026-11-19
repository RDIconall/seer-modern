"use client";

import { useEffect, type FormEvent, type ReactNode } from "react";
import { clearPersistedMailboxCaches } from "@/lib/v3/mailbox/cache";

/**
 * Login and reconnect forms run as server actions. The previous session's
 * mailbox and unsent drafts live in localStorage, which the server cannot
 * see, so the submit has to drop them here before OAuth navigates away.
 *
 * These screens only render with no usable session, so they also clear on
 * mount: a composer's debounced save can land after the sign-out submit, and
 * a session can end without passing through any sign-out form.
 */
export function ForgetCachedInbox({ children }: { children: ReactNode }) {
  useEffect(() => {
    clearPersistedMailboxCaches();
  }, []);

  function forget(event: FormEvent) {
    if (!(event.target instanceof HTMLFormElement)) return;
    clearPersistedMailboxCaches();
  }

  return <div onSubmitCapture={forget}>{children}</div>;
}
