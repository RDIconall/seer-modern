import type { Metadata, Viewport } from "next";

export const metadata: Metadata = {
  title: "Inbox Pilot",
  description: "Mobile mail PWA — swipe, compose, triage",
  appleWebApp: {
    capable: true,
    statusBarStyle: "default",
    title: "Inbox Pilot",
  },
  manifest: "/manifest.webmanifest",
};

export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#1a73e8" },
    { media: "(prefers-color-scheme: dark)", color: "#0b57d0" },
  ],
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
  viewportFit: "cover",
};

export default function MobileLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return children;
}
