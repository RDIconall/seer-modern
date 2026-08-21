"use client";

import { useEffect } from "react";

/**
 * Register the service worker for the whole app, and — the part that
 * matters — make an installed app notice that it has been redeployed.
 *
 * An installed iOS app resumed from the background often does not navigate at
 * all: the page is restored as it was, so nothing asks the server whether there
 * is newer code. Combined with a worker that could serve an old shell, this
 * left the app running a build from days earlier with no sign anything was
 * wrong. Checking for an update whenever the app comes back to the foreground
 * is what closes that gap.
 *
 * The scope is the whole origin because a browser only offers to install an app
 * whose worker covers the page you are standing on, and Seer is now installable
 * from the desktop route as well as the phone one.
 */
export function PwaRegister() {
  useEffect(() => {
    if (!("serviceWorker" in navigator)) return;

    let reloading = false;
    // A worker taking control means the code on disk is not the code running.
    // Reload once — guarded, because a reload loop is worse than a stale app.
    const onControllerChange = () => {
      if (reloading) return;
      reloading = true;
      window.location.reload();
    };

    let registration: ServiceWorkerRegistration | null = null;
    const checkForUpdate = () => {
      if (document.visibilityState !== "visible") return;
      void registration?.update();
    };

    const register = async () => {
      try {
        // Drop caches from earlier shells, including the one that could pin the
        // app to an old build.
        const keys = await caches.keys();
        await Promise.all(
          keys
            .filter((k) => k.startsWith("seer-mobile-") && k !== "seer-mobile-v3")
            .map((k) => caches.delete(k)),
        );

        registration = await navigator.serviceWorker.register("/sw.js", {
          scope: "/",
          updateViaCache: "none",
        });
        await registration.update();

        // Phones that installed Seer before this had a worker scoped to /m.
        // Leaving it registered means two workers claiming the mobile route.
        const existing = await navigator.serviceWorker.getRegistrations();
        await Promise.all(
          existing
            .filter((item) => new URL(item.scope).pathname !== "/")
            .map((item) => item.unregister()),
        );

        navigator.serviceWorker.addEventListener(
          "controllerchange",
          onControllerChange,
        );
        document.addEventListener("visibilitychange", checkForUpdate);
      } catch {
        /* ignore in unsupported browsers */
      }
    };

    if (document.readyState === "complete") void register();
    else window.addEventListener("load", () => void register(), { once: true });

    return () => {
      navigator.serviceWorker.removeEventListener(
        "controllerchange",
        onControllerChange,
      );
      document.removeEventListener("visibilitychange", checkForUpdate);
    };
  }, []);

  return null;
}
