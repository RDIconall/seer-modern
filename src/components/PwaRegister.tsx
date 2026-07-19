"use client";

import { useEffect } from "react";
import { usePathname } from "next/navigation";

/** Register the service worker only on the mobile app route (/m). */
export function PwaRegister() {
  const pathname = usePathname();

  useEffect(() => {
    if (!("serviceWorker" in navigator)) return;
    if (!pathname?.startsWith("/m")) return;

    const register = () => {
      navigator.serviceWorker.register("/sw.js", { scope: "/m" }).catch(() => {
        /* ignore in unsupported browsers */
      });
    };
    if (document.readyState === "complete") register();
    else window.addEventListener("load", register, { once: true });
  }, [pathname]);

  return null;
}
