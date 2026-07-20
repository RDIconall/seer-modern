"use client";

import { useEffect } from "react";
import { usePathname } from "next/navigation";

/** Register the service worker only on the mobile app route (/m). */
export function PwaRegister() {
  const pathname = usePathname();

  useEffect(() => {
    if (!("serviceWorker" in navigator)) return;
    if (!pathname?.startsWith("/m")) return;

    const register = async () => {
      try {
        // Drop stale v1 caches that pinned the spectrum mark / old shell
        const keys = await caches.keys();
        await Promise.all(
          keys
            .filter((k) => k.startsWith("seer-mobile-") && k !== "seer-mobile-v2")
            .map((k) => caches.delete(k)),
        );

        const reg = await navigator.serviceWorker.register("/sw.js", {
          scope: "/m",
          updateViaCache: "none",
        });
        await reg.update();
      } catch {
        /* ignore in unsupported browsers */
      }
    };

    if (document.readyState === "complete") void register();
    else window.addEventListener("load", () => void register(), { once: true });
  }, [pathname]);

  return null;
}
