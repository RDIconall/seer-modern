import type { Metadata, Viewport } from "next";

export const metadata: Metadata = {
  title: "Seer",
  description: "Work smarter — mobile email copilot",
  appleWebApp: {
    capable: true,
    statusBarStyle: "default",
    title: "Seer",
  },
  manifest: "/manifest.webmanifest",
};

export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#3498d9" },
    { media: "(prefers-color-scheme: dark)", color: "#1e4a66" },
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
