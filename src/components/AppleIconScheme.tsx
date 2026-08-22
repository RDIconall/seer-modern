"use client";

import { useEffect } from "react";

const LIGHT = "/icons/apple-touch-icon.png";
const DARK = "/icons/apple-touch-icon-dark.png";

/**
 * Point the Apple touch icon at the dark artwork while the phone is in dark
 * mode.
 *
 * Safari ignores `media` on `<link rel="apple-touch-icon">`, so the light and
 * dark tiles cannot be declared side by side the way favicons can — iOS would
 * simply take one of them. It reads the link once, at the moment someone taps
 * Add to Home Screen, so the honest thing this can do is make sure the right
 * artwork is the one on offer at that moment.
 *
 * What that means in practice: an icon already sitting on a home screen does
 * not change when the phone switches to dark mode. Re-adding the app picks up
 * whichever scheme is current.
 */
export function AppleIconScheme() {
  useEffect(() => {
    const link = document.querySelector<HTMLLinkElement>(
      'link[rel="apple-touch-icon"]',
    );
    if (!link || typeof window.matchMedia !== "function") return;

    const dark = window.matchMedia("(prefers-color-scheme: dark)");
    const apply = () => {
      const next = dark.matches ? DARK : LIGHT;
      // Rewriting an unchanged href would make Safari refetch the tile.
      if (!link.href.endsWith(next)) link.href = next;
    };

    apply();
    dark.addEventListener("change", apply);
    return () => dark.removeEventListener("change", apply);
  }, []);

  return null;
}
