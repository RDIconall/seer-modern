"use client";

import { useEffect } from "react";
import { usePathname } from "next/navigation";

/**
 * Register the service worker on the mobile app route, and — the part that
 * matters — make an installed app notice that it has been redeployed.
 *
 * An installed iOS app resumed from the background often does not navigate at
 * all: the page is restored as it was, so nothing asks the server whether there
 * is newer code. Combined with a worker that could serve an old shell, this
 * left the app running a build from days earlier with no sign anything was
 * wrong. Checking for an update whenever the app comes back to the foreground
 * is what closes that gap.
 */
export function PwaRegister() {
  const pathname = usePathname();

  useEffect(() => {
    if (!("serviceWorker" in navigator)) return;
    if (!pathname?.startsWith("/m")) return;

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
          scope: "/m",
          updateViaCache: "none",
        });
        await registration.update();
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
  }, [pathname]);

  return null;
}
